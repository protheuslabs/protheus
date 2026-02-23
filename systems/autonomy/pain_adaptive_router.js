#!/usr/bin/env node
'use strict';

/**
 * systems/autonomy/pain_adaptive_router.js
 *
 * Route recurring pain signatures into adaptive layers (reflex/habit) as
 * disabled candidates, then emit deterministic implementation proposals.
 *
 * Safety model:
 * - High-risk / critical signatures are NOT auto-routed.
 * - Routed candidates are disabled by default.
 * - Uses adaptive controllers only (no direct adaptive file writes).
 *
 * Usage:
 *   node systems/autonomy/pain_adaptive_router.js run [YYYY-MM-DD]
 *   node systems/autonomy/pain_adaptive_router.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mutateHabitState, readHabitState } = require('../adaptive/habits/habit_store.js');
const { mutateReflexState, readReflexState } = require('../adaptive/reflex/reflex_store.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PAIN_STATE_PATH = process.env.PAIN_SIGNAL_STATE_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_STATE_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_state.json');
const PAIN_ROUTE_STATE_PATH = process.env.PAIN_ROUTE_STATE_PATH
  ? path.resolve(String(process.env.PAIN_ROUTE_STATE_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_adaptive_routes_state.json');
const PAIN_ROUTE_LOG_PATH = process.env.PAIN_ROUTE_LOG_PATH
  ? path.resolve(String(process.env.PAIN_ROUTE_LOG_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_adaptive_routes.jsonl');
const PROPOSALS_DIR = process.env.PAIN_SIGNAL_PROPOSALS_DIR
  ? path.resolve(String(process.env.PAIN_SIGNAL_PROPOSALS_DIR))
  : path.join(ROOT, 'state', 'sensory', 'proposals');
const VERSION = '1.0';

function nowIso() {
  return new Date().toISOString();
}

function todayStr(v = null) {
  const d = v ? new Date(String(v)) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function clean(v, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeKey(v, maxLen = 80) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 16);
}

function riskScore(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'high') return 3;
  return 2;
}

function severityScore(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'high') return 3;
  if (s === 'critical') return 4;
  return 2;
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function signalAgeHours(row) {
  const ts = parseIsoMs(row && row.last_ts);
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / (60 * 60 * 1000);
}

function recentWindowCount(row, windowHours) {
  const history = Array.isArray(row && row.events) ? row.events : [];
  const maxHours = Math.max(1, Number(windowHours || 24));
  const nowMs = Date.now();
  let count = 0;
  for (const evt of history) {
    const ms = parseIsoMs(evt && evt.ts);
    if (!Number.isFinite(ms)) continue;
    if ((nowMs - ms) <= maxHours * 60 * 60 * 1000) count += 1;
  }
  if (count > 0) return count;
  const total = Number(row && row.total_count || 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function hasEscalationEvidence(row) {
  const lastProposal = clean(row && row.last_proposal_id || '', 120);
  const escalationTs = parseIsoMs(row && row.last_escalation_ts);
  return !!lastProposal || Number.isFinite(escalationTs);
}

function loadPainState() {
  const base = readJsonSafe(PAIN_STATE_PATH, null);
  if (!base || typeof base !== 'object') return { signatures: {} };
  return {
    signatures: base.signatures && typeof base.signatures === 'object' ? base.signatures : {}
  };
}

function loadRouteState() {
  const base = readJsonSafe(PAIN_ROUTE_STATE_PATH, null);
  if (!base || typeof base !== 'object') {
    return {
      version: VERSION,
      updated_ts: null,
      routes: {}
    };
  }
  return {
    version: VERSION,
    updated_ts: String(base.updated_ts || '') || null,
    routes: base.routes && typeof base.routes === 'object' ? base.routes : {}
  };
}

function saveRouteState(state) {
  writeJson(PAIN_ROUTE_STATE_PATH, {
    version: VERSION,
    updated_ts: nowIso(),
    routes: state && state.routes && typeof state.routes === 'object' ? state.routes : {}
  });
}

function loadProposals(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const filePath = path.join(PROPOSALS_DIR, `${date}.json`);
  const rows = readJsonSafe(filePath, []);
  return {
    date,
    filePath,
    proposals: Array.isArray(rows) ? rows : []
  };
}

function saveProposals(filePath, proposals) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(Array.isArray(proposals) ? proposals : [], null, 2) + '\n', 'utf8');
}

function classifyLayer(row, cfg) {
  const total = Number(row && row.total_count || 0);
  const risk = riskScore(row && row.risk);
  const severity = severityScore(row && row.severity);
  const recentCount = recentWindowCount(row, cfg.recent_window_hours);
  const detailsLen = clean(row && row.last_details || row && row.details || '', 1200).length;
  const complexity = 1 + (detailsLen > 240 ? 1 : 0) + (detailsLen > 600 ? 1 : 0);
  const code = normalizeKey(row && row.code || '', 64);
  const isTransportFailure = /(dns|timeout|network|tls|connection|refused|reset|http_5xx|rate_limited|env_blocked)/.test(code);
  const hasEscalation = hasEscalationEvidence(row);

  if (risk >= 3) return { layer: null, reason: 'risk_high' };
  if (severity >= 4) return { layer: null, reason: 'severity_critical' };
  if (total < cfg.reflex_min_repeats && recentCount < cfg.reflex_min_repeats) {
    return { layer: null, reason: 'below_reflex_threshold' };
  }

  const reflexScore = (
    (Math.min(6, recentCount) * 11)
    + (isTransportFailure ? 14 : 0)
    + (complexity <= 2 ? 10 : 0)
    + (severity <= 2 ? 8 : 0)
    + (hasEscalation ? 8 : 0)
    - (severity >= 3 ? 14 : 0)
    - (complexity >= 3 ? 10 : 0)
  );
  const habitScore = (
    (Math.min(8, total) * 9)
    + (severity >= 3 ? 18 : 0)
    + (complexity >= 3 ? 16 : 0)
    + (recentCount >= cfg.habit_min_repeats ? 12 : 0)
    + (hasEscalation ? 6 : 0)
  );

  if (
    total >= cfg.habit_min_repeats
    || severity >= 3
    || complexity >= 3
    || habitScore >= (reflexScore + 8)
  ) {
    return {
      layer: 'habit',
      reason: 'recurring_or_complex_pattern',
      scores: { reflex: reflexScore, habit: habitScore },
      recent_count: recentCount
    };
  }
  return {
    layer: 'reflex',
    reason: 'low_latency_recurring_pattern',
    scores: { reflex: reflexScore, habit: habitScore },
    recent_count: recentCount
  };
}

function shouldRouteByState(signature, layer, totalCount, routeState, cfg) {
  const prev = routeState.routes && routeState.routes[signature] && typeof routeState.routes[signature] === 'object'
    ? routeState.routes[signature]
    : {};
  const nowMs = Date.now();
  const cooldownMs = parseIsoMs(prev.cooldown_until_ts);
  if (Number.isFinite(cooldownMs) && cooldownMs > nowMs) {
    return { ok: false, reason: 'route_cooldown_active' };
  }

  const lastReflex = Number(prev.last_reflex_count || 0);
  const lastHabit = Number(prev.last_habit_count || 0);
  if (layer === 'reflex') {
    const minCount = Math.max(cfg.reflex_min_repeats, lastReflex + cfg.rearm_step);
    if (totalCount < minCount) return { ok: false, reason: 'reflex_rearm_not_met' };
    return { ok: true, reason: 'reflex_threshold_met' };
  }
  if (layer === 'habit') {
    const minCount = Math.max(cfg.habit_min_repeats, lastHabit + cfg.rearm_step);
    if (totalCount < minCount) return { ok: false, reason: 'habit_rearm_not_met' };
    return { ok: true, reason: 'habit_threshold_met' };
  }
  return { ok: false, reason: 'unknown_layer' };
}

function buildReflexCandidate(signature, row) {
  const sid = String(signature || '').slice(0, 12);
  const source = normalizeKey(row && row.source || 'source', 40) || 'source';
  const code = normalizeKey(row && row.code || 'error', 40) || 'error';
  const key = normalizeKey(`pain_${source}_${sid}`, 80) || `pain_${sid}`;
  return {
    key,
    name: clean(`Pain Reflex ${source} ${code}`, 120),
    trigger: clean(`pain_signal:${source}:${code}`, 200),
    action: clean(`stabilize ${normalizeKey(row && row.subsystem || source, 40)} via deterministic recovery playbook`, 240),
    status: 'disabled',
    priority: Math.max(40, Math.min(95, 45 + Number(row && row.total_count || 0)))
  };
}

function buildHabitCandidate(signature, row) {
  const sid = String(signature || '').slice(0, 12);
  const source = normalizeKey(row && row.source || 'source', 40) || 'source';
  const id = normalizeKey(`pain_${source}_${sid}`, 80) || `pain_${sid}`;
  return {
    id,
    name: clean(`Pain Habit ${source} ${normalizeKey(row && row.code || 'error', 32)}`, 120),
    summary: clean(row && row.summary || `Recurring pain pattern from ${source}`, 240),
    routine_path: clean(`habits/routines/${id}.js`, 240),
    status: 'disabled'
  };
}

function upsertReflexCandidate(signature, row) {
  const cand = buildReflexCandidate(signature, row);
  let op = 'none';
  mutateReflexState(null, (state) => {
    const rows = Array.isArray(state.routines) ? state.routines : [];
    const idx = rows.findIndex((r) => String(r && r.key || '') === cand.key);
    const ts = nowIso();
    if (idx >= 0) {
      const prev = rows[idx] || {};
      rows[idx] = {
        ...prev,
        key: cand.key,
        name: cand.name,
        trigger: cand.trigger,
        action: cand.action,
        priority: cand.priority,
        status: String(prev.status || 'disabled') === 'active' ? 'active' : 'disabled',
        updated_ts: ts
      };
      state.metrics = state.metrics || {};
      state.metrics.total_updated = Number(state.metrics.total_updated || 0) + 1;
      op = 'updated';
    } else {
      rows.push({
        ...cand,
        last_run_ts: null,
        created_ts: ts,
        updated_ts: ts
      });
      state.metrics = state.metrics || {};
      state.metrics.total_created = Number(state.metrics.total_created || 0) + 1;
      op = 'created';
    }
    state.routines = rows;
    return state;
  }, {
    source: 'systems/autonomy/pain_adaptive_router.js',
    reason: `route_pain_to_reflex:${cand.key}`
  });
  return { candidate_id: cand.key, op };
}

function upsertHabitCandidate(signature, row) {
  const cand = buildHabitCandidate(signature, row);
  let op = 'none';
  mutateHabitState(null, (state) => {
    const rows = Array.isArray(state.routines) ? state.routines : [];
    const idx = rows.findIndex((r) => String(r && r.id || '') === cand.id);
    const ts = nowIso();
    if (idx >= 0) {
      const prev = rows[idx] || {};
      rows[idx] = {
        ...prev,
        id: cand.id,
        name: cand.name,
        summary: cand.summary,
        routine_path: cand.routine_path,
        status: String(prev.status || 'disabled') === 'active' ? 'active' : 'disabled',
        updated_ts: ts
      };
      state.metrics = state.metrics || {};
      state.metrics.total_updated = Number(state.metrics.total_updated || 0) + 1;
      op = 'updated';
    } else {
      rows.push({
        ...cand,
        usage: {
          uses_total: 0,
          uses_30d: 0,
          last_used_ts: null
        },
        created_ts: ts,
        updated_ts: ts
      });
      state.metrics = state.metrics || {};
      state.metrics.total_created = Number(state.metrics.total_created || 0) + 1;
      op = 'created';
    }
    state.routines = rows;
    return state;
  }, {
    source: 'systems/autonomy/pain_adaptive_router.js',
    reason: `route_pain_to_habit:${cand.id}`
  });
  return { candidate_id: cand.id, op };
}

function buildRouteProposal(dateStr, signature, row, layer, candidateId, routeReason) {
  const proposalId = `PAINRT-${sha16(`${signature}|${layer}`)}`;
  const source = clean(row && row.source || 'pain_signal', 64);
  const code = clean(row && row.code || 'unknown_code', 64);
  const summary = clean(row && row.summary || `Recurring pain pattern (${source}/${code})`, 240);
  const task = (
    `Implement candidate ${layer} routine (${candidateId}) for recurring pain pattern ${signature}. ` +
    `Keep it general, deterministic, low-risk, and reusable across similar failures. ` +
    `Add explicit rollback and verification steps.`
  ).replace(/"/g, '\\"');
  return {
    id: proposalId,
    type: 'pain_adaptive_candidate',
    title: `[Pain→${layer}] ${summary}`.slice(0, 120),
    summary: `Recurring pain signature routed to ${layer} candidate ${candidateId} (disabled by default).`,
    expected_impact: 'medium',
    risk: 'low',
    validation: [
      'postconditions pass on next run',
      'outcome receipt logged on next run',
      'at least 1 artifact produced within 24h',
      'failure frequency for this signature decreases over next 3 comparable runs'
    ],
    suggested_next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=900 --repeats_14d=2 --errors_30d=1 --dry-run`,
    action_spec: {
      objective: `Stabilize recurring pain response by implementing deterministic ${layer} runtime handling for ${candidateId}.`,
      target: layer === 'habit'
        ? 'systems/adaptive/habits/habit_runtime_sync.js'
        : 'systems/adaptive/reflex/reflex_runtime_sync.js',
      next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=900 --repeats_14d=2 --errors_30d=1 --dry-run`,
      rollback: 'Revert modified sync/controller files and keep candidate disabled in adaptive registry.',
      verify: [
        'postconditions pass on next run',
        'outcome receipt logged on next run',
        'failure count does not increase in next 2 runs'
      ],
      success_criteria: [
        { metric: 'postconditions_ok', target: 'postconditions pass', horizon: 'next run' },
        { metric: 'queue_outcome_logged', target: 'outcome receipt logged', horizon: 'next run' },
        { metric: 'artifact_count', target: '>=1 artifact', horizon: '24h' }
      ]
    },
    evidence: [
      {
        source: 'pain_signal',
        path: 'state/autonomy/pain_signals.jsonl',
        match: `${source}:${code}:${signature}`.slice(0, 120),
        evidence_ref: `pain:${signature}`
      }
    ],
    meta: {
      source_eye: 'pain_adaptive_router',
      pain_signature: signature,
      pain_source: source,
      pain_code: code,
      pain_total_count: Number(row && row.total_count || 0),
      target_layer: layer,
      candidate_id: candidateId,
      route_reason: routeReason,
      generated_at: nowIso()
    }
  };
}

function addProposalIfMissing(dateStr, proposal) {
  const ctx = loadProposals(dateStr);
  const proposalId = String(proposal && proposal.id || '');
  const idx = ctx.proposals.findIndex((p) => p && String(p.id || '') === proposalId);
  if (idx >= 0) {
    const prev = ctx.proposals[idx];
    if (JSON.stringify(prev) === JSON.stringify(proposal)) {
      return { added: false, updated: false, proposal_id: proposalId };
    }
    ctx.proposals[idx] = proposal;
    saveProposals(ctx.filePath, ctx.proposals);
    return { added: false, updated: true, proposal_id: proposalId };
  }
  ctx.proposals.push(proposal);
  saveProposals(ctx.filePath, ctx.proposals);
  return { added: true, updated: false, proposal_id: proposalId };
}

function routeOneSignature(dateStr, signature, row, cfg, routeState) {
  const totalCount = Number(row && row.total_count || 0);
  const lane = classifyLayer(row, cfg);
  if (!lane.layer) return { routed: false, reason: lane.reason, layer: null };
  const gate = shouldRouteByState(signature, lane.layer, totalCount, routeState, cfg);
  if (!gate.ok) return { routed: false, reason: gate.reason, layer: lane.layer };

  let routeResult = null;
  if (lane.layer === 'reflex') {
    routeResult = upsertReflexCandidate(signature, row);
  } else if (lane.layer === 'habit') {
    routeResult = upsertHabitCandidate(signature, row);
  } else {
    return { routed: false, reason: 'unsupported_layer', layer: null };
  }

  const proposal = buildRouteProposal(
    dateStr,
    signature,
    row,
    lane.layer,
    routeResult.candidate_id,
    lane.reason
  );
  const proposalAdd = addProposalIfMissing(dateStr, proposal);

  const prev = routeState.routes && routeState.routes[signature] && typeof routeState.routes[signature] === 'object'
    ? routeState.routes[signature]
    : {};
  const cooldownUntil = new Date(Date.now() + (cfg.route_cooldown_hours * 60 * 60 * 1000)).toISOString();
  routeState.routes[signature] = {
    source: clean(row && row.source || '', 96),
    subsystem: clean(row && row.subsystem || '', 96),
    code: clean(row && row.code || '', 96),
    last_layer: lane.layer,
    last_route_ts: nowIso(),
    cooldown_until_ts: cooldownUntil,
    last_reflex_count: lane.layer === 'reflex' ? totalCount : Number(prev.last_reflex_count || 0),
    last_habit_count: lane.layer === 'habit' ? totalCount : Number(prev.last_habit_count || 0),
    last_total_count: totalCount,
    last_candidate_id: routeResult.candidate_id,
    last_proposal_id: proposal.id
  };

  appendJsonl(PAIN_ROUTE_LOG_PATH, {
    ts: nowIso(),
    type: 'pain_adaptive_route',
    signature,
    source: row && row.source || null,
    code: row && row.code || null,
    total_count: totalCount,
    layer: lane.layer,
    route_reason: lane.reason,
    route_scores: lane.scores || null,
    recent_count: Number.isFinite(Number(lane.recent_count)) ? Number(lane.recent_count) : null,
    gate_reason: gate.reason,
    candidate_id: routeResult.candidate_id,
    candidate_op: routeResult.op,
    proposal_id: proposal.id,
    proposal_added: proposalAdd.added === true,
    proposal_updated: proposalAdd.updated === true
  });

  return {
    routed: true,
    reason: lane.reason,
    layer: lane.layer,
    scores: lane.scores || null,
    recent_count: Number.isFinite(Number(lane.recent_count)) ? Number(lane.recent_count) : null,
    candidate_id: routeResult.candidate_id,
    candidate_op: routeResult.op,
    proposal_id: proposal.id,
    proposal_added: proposalAdd.added === true,
    proposal_updated: proposalAdd.updated === true
  };
}

function loadConfig() {
  return {
    reflex_min_repeats: Math.max(1, Number(process.env.PAIN_ROUTE_REFLEX_MIN_REPEATS || 3)),
    habit_min_repeats: Math.max(2, Number(process.env.PAIN_ROUTE_HABIT_MIN_REPEATS || 5)),
    recent_window_hours: Math.max(1, Number(process.env.PAIN_ROUTE_RECENT_WINDOW_HOURS || 24)),
    rearm_step: Math.max(1, Number(process.env.PAIN_ROUTE_REARM_STEP || 3)),
    max_routes_per_run: Math.max(1, Number(process.env.PAIN_ROUTE_MAX_PER_RUN || 6)),
    route_cooldown_hours: Math.max(1, Number(process.env.PAIN_ROUTE_COOLDOWN_HOURS || 6)),
    max_signal_age_hours: Math.max(1, Number(process.env.PAIN_ROUTE_MAX_SIGNAL_AGE_HOURS || 168)),
    require_escalation_artifact: String(process.env.PAIN_ROUTE_REQUIRE_ESCALATION_ARTIFACT || '1') !== '0'
  };
}

function run(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const cfg = loadConfig();
  const pain = loadPainState();
  const routeState = loadRouteState();
  if (!routeState.routes || typeof routeState.routes !== 'object') routeState.routes = {};
  const signatures = Object.entries(pain.signatures || {})
    .map(([signature, row]) => ({ signature: String(signature || ''), row: row && typeof row === 'object' ? row : {} }))
    .filter((x) => x.signature)
    .sort((a, b) => Number(b.row.total_count || 0) - Number(a.row.total_count || 0));

  const out = {
    ok: true,
    type: 'pain_adaptive_router',
    date,
    config: cfg,
    scanned: signatures.length,
    routed: 0,
    routed_reflex: 0,
    routed_habit: 0,
    skipped: 0,
    details: []
  };

  for (const item of signatures) {
    if (out.routed >= cfg.max_routes_per_run) break;
    const row = item.row || {};
    const ageHours = signalAgeHours(row);
    if (Number.isFinite(ageHours) && ageHours > cfg.max_signal_age_hours) {
      out.skipped += 1;
      out.details.push({
        signature: item.signature,
        routed: false,
        reason: 'signal_stale',
        signal_age_hours: Number(ageHours.toFixed(2))
      });
      continue;
    }
    if (cfg.require_escalation_artifact) {
      const escalationEvidence = hasEscalationEvidence(row);
      const recurrenceEvidence = recentWindowCount(row, cfg.recent_window_hours) >= cfg.reflex_min_repeats;
      if (!escalationEvidence && !recurrenceEvidence) {
        out.skipped += 1;
        out.details.push({
          signature: item.signature,
          routed: false,
          reason: 'missing_route_evidence',
          escalation_evidence: escalationEvidence,
          recurrence_evidence: recurrenceEvidence
        });
        continue;
      }
    }
    const lanePreview = classifyLayer(row, cfg);
    const result = routeOneSignature(date, item.signature, row, cfg, routeState);
    if (result.routed) {
      out.routed += 1;
      if (result.layer === 'reflex') out.routed_reflex += 1;
      if (result.layer === 'habit') out.routed_habit += 1;
    } else {
      out.skipped += 1;
    }
    out.details.push({
      signature: item.signature,
      total_count: Number(row.total_count || 0),
      source: clean(row.source || '', 64) || null,
      code: clean(row.code || '', 64) || null,
      signal_age_hours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
      route_scores: (result && result.scores) || (lanePreview && lanePreview.scores) || null,
      recent_count: Number.isFinite(Number(result && result.recent_count))
        ? Number(result.recent_count)
        : (Number.isFinite(Number(lanePreview && lanePreview.recent_count))
          ? Number(lanePreview.recent_count)
          : null),
      ...result
    });
  }

  saveRouteState(routeState);
  appendJsonl(PAIN_ROUTE_LOG_PATH, {
    ts: nowIso(),
    type: 'pain_adaptive_router_run',
    date,
    scanned: out.scanned,
    routed: out.routed,
    routed_reflex: out.routed_reflex,
    routed_habit: out.routed_habit,
    skipped: out.skipped
  });

  return out;
}

function status() {
  const cfg = loadConfig();
  const pain = loadPainState();
  const routeState = loadRouteState();
  const habitState = readHabitState(null, null);
  const reflexState = readReflexState(null, null);
  return {
    ok: true,
    type: 'pain_adaptive_router_status',
    config: cfg,
    pain_signatures: Object.keys(pain.signatures || {}).length,
    route_signatures: Object.keys(routeState.routes || {}).length,
    adaptive: {
      habit_routines: Array.isArray(habitState && habitState.routines) ? habitState.routines.length : 0,
      reflex_routines: Array.isArray(reflexState && reflexState.routines) ? reflexState.routines.length : 0
    }
  };
}

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  node systems/autonomy/pain_adaptive_router.js run [YYYY-MM-DD]\n' +
    '  node systems/autonomy/pain_adaptive_router.js status\n'
  );
}

function main() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    const dateStr = process.argv[3] || null;
    process.stdout.write(JSON.stringify(run(dateStr)) + '\n');
    return;
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status()) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown_command:${cmd}` }) + '\n');
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  status
};

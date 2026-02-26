#!/usr/bin/env node
'use strict';

/**
 * systems/autonomy/pain_signal.js
 *
 * Generic "pain signal" contract:
 * - Record hard/recurring failures into a single ledger.
 * - Apply deterministic threshold + cooldown escalation.
 * - Emit escalation proposals into state/sensory/proposals/YYYY-MM-DD.json
 *   so the existing proposal/autonomy pipeline can triage them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PAIN_STATE_PATH = process.env.PAIN_SIGNAL_STATE_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_STATE_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_state.json');
const PAIN_LOG_PATH = process.env.PAIN_SIGNAL_LOG_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_LOG_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_signals.jsonl');
const PAIN_POLICY_PATH = process.env.PAIN_SIGNAL_POLICY_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_POLICY_PATH))
  : path.join(ROOT, 'config', 'pain_signal_policy.json');
const PAIN_FOCUS_STATE_PATH = process.env.PAIN_SIGNAL_FOCUS_STATE_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_FOCUS_STATE_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_focus_state.json');
const PAIN_FOCUS_AUDIT_PATH = process.env.PAIN_SIGNAL_FOCUS_AUDIT_PATH
  ? path.resolve(String(process.env.PAIN_SIGNAL_FOCUS_AUDIT_PATH))
  : path.join(ROOT, 'state', 'autonomy', 'pain_focus_events.jsonl');
const SYSTEM_HEALTH_EVENTS_PATH = process.env.SYSTEM_HEALTH_EVENTS_PATH
  ? path.resolve(String(process.env.SYSTEM_HEALTH_EVENTS_PATH))
  : path.join(ROOT, 'state', 'ops', 'system_health', 'events.jsonl');
const PROPOSALS_DIR = process.env.PAIN_SIGNAL_PROPOSALS_DIR
  ? path.resolve(String(process.env.PAIN_SIGNAL_PROPOSALS_DIR))
  : path.join(ROOT, 'state', 'sensory', 'proposals');
const PAIN_SIGNAL_VERSION = '1.0';
const PAIN_FOCUS_VERSION = '1.0';

function nowIso() {
  return new Date().toISOString();
}

function todayStr(ts = null) {
  const d = ts ? new Date(String(ts)) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function appendSystemHealthEvent(row) {
  appendJsonl(SYSTEM_HEALTH_EVENTS_PATH, row);
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

function loadPainState() {
  const base = readJsonSafe(PAIN_STATE_PATH, null);
  if (!base || typeof base !== 'object') {
    return {
      version: PAIN_SIGNAL_VERSION,
      updated_ts: null,
      signatures: {}
    };
  }
  return {
    version: PAIN_SIGNAL_VERSION,
    updated_ts: String(base.updated_ts || '') || null,
    signatures: base.signatures && typeof base.signatures === 'object'
      ? base.signatures
      : {}
  };
}

function savePainState(state) {
  writeJson(PAIN_STATE_PATH, {
    version: PAIN_SIGNAL_VERSION,
    updated_ts: nowIso(),
    signatures: state && state.signatures && typeof state.signatures === 'object'
      ? state.signatures
      : {}
  });
}

function sha16(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 16);
}

function normalizeText(v, fallback = '') {
  const s = String(v == null ? '' : v).trim();
  return s || fallback;
}

function normalizeRisk(v, fallback = 'medium') {
  const s = normalizeText(v, fallback).toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return fallback;
}

function normalizeSeverity(v, fallback = 'medium') {
  const s = normalizeText(v, fallback).toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical') return s;
  return fallback;
}

function severityRank(v) {
  const s = normalizeSeverity(v, 'medium');
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'high') return 3;
  if (s === 'critical') return 4;
  return 2;
}

function riskRank(v) {
  const s = normalizeRisk(v, 'medium');
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'high') return 3;
  return 2;
}

function normalizeNumber(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizePatternList(v, fallback = []) {
  const arr = Array.isArray(v) ? v : fallback;
  return arr
    .map((x) => normalizeText(x, '').toLowerCase())
    .filter(Boolean)
    .slice(0, 64);
}

function normalizeBoolean(v, fallback) {
  if (typeof v === 'boolean') return v;
  const s = normalizeText(v, '').toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function loadPainPolicy() {
  const defaults = {
    version: '1.0',
    defer_enabled: true,
    defer_during_focus: true,
    focus_default_ttl_minutes: 30,
    focus_max_ttl_minutes: 240,
    defer_max_per_signature: 3,
    force_escalate_after_window_failures: 10,
    no_defer: {
      min_severity: 'high',
      min_risk: 'high',
      code_patterns: [
        'security',
        'integrity',
        'guard',
        'attestation',
        'emergency',
        'budget_hard_stop',
        'data_loss',
        'corrupt',
        'exfil',
        'unauthorized'
      ],
      source_patterns: ['security', 'secret_broker']
    }
  };
  const raw = readJsonSafe(PAIN_POLICY_PATH, {});
  const nd = raw && raw.no_defer && typeof raw.no_defer === 'object' ? raw.no_defer : {};
  return {
    version: normalizeText(raw.version, defaults.version),
    defer_enabled: normalizeBoolean(raw.defer_enabled, defaults.defer_enabled),
    defer_during_focus: normalizeBoolean(raw.defer_during_focus, defaults.defer_during_focus),
    focus_default_ttl_minutes: normalizeNumber(
      raw.focus_default_ttl_minutes,
      defaults.focus_default_ttl_minutes,
      5,
      24 * 60
    ),
    focus_max_ttl_minutes: normalizeNumber(
      raw.focus_max_ttl_minutes,
      defaults.focus_max_ttl_minutes,
      5,
      24 * 60
    ),
    defer_max_per_signature: normalizeNumber(
      raw.defer_max_per_signature,
      defaults.defer_max_per_signature,
      0,
      100
    ),
    force_escalate_after_window_failures: normalizeNumber(
      raw.force_escalate_after_window_failures,
      defaults.force_escalate_after_window_failures,
      0,
      1000
    ),
    no_defer: {
      min_severity: normalizeSeverity(nd.min_severity, defaults.no_defer.min_severity),
      min_risk: normalizeRisk(nd.min_risk, defaults.no_defer.min_risk),
      code_patterns: normalizePatternList(nd.code_patterns, defaults.no_defer.code_patterns),
      source_patterns: normalizePatternList(nd.source_patterns, defaults.no_defer.source_patterns)
    }
  };
}

function loadPainFocusState() {
  const base = readJsonSafe(PAIN_FOCUS_STATE_PATH, null);
  if (!base || typeof base !== 'object') {
    return {
      version: PAIN_FOCUS_VERSION,
      updated_ts: null,
      active: null
    };
  }
  const active = base.active && typeof base.active === 'object' ? base.active : null;
  return {
    version: PAIN_FOCUS_VERSION,
    updated_ts: String(base.updated_ts || '') || null,
    active: active
      ? {
          id: normalizeText(active.id, ''),
          task: normalizeText(active.task, '').slice(0, 240),
          source: normalizeText(active.source, '').slice(0, 120),
          reason: normalizeText(active.reason, '').slice(0, 200),
          started_ts: normalizeText(active.started_ts, ''),
          expires_ts: normalizeText(active.expires_ts, '')
        }
      : null
  };
}

function savePainFocusState(state) {
  writeJson(PAIN_FOCUS_STATE_PATH, {
    version: PAIN_FOCUS_VERSION,
    updated_ts: nowIso(),
    active: state && state.active && typeof state.active === 'object'
      ? {
          id: normalizeText(state.active.id, ''),
          task: normalizeText(state.active.task, '').slice(0, 240),
          source: normalizeText(state.active.source, '').slice(0, 120),
          reason: normalizeText(state.active.reason, '').slice(0, 200),
          started_ts: normalizeText(state.active.started_ts, ''),
          expires_ts: normalizeText(state.active.expires_ts, '')
        }
      : null
  });
}

function appendPainFocusAudit(row) {
  appendJsonl(PAIN_FOCUS_AUDIT_PATH, row);
}

function activeFocusSession(state = null, nowMs = Date.now()) {
  const s = state || loadPainFocusState();
  const active = s && s.active && typeof s.active === 'object' ? s.active : null;
  if (!active) return { active: false, session: null, expired: false };
  const expiry = parseIsoMs(active.expires_ts);
  if (Number.isFinite(expiry) && expiry > nowMs) {
    return { active: true, session: active, expired: false };
  }
  if (Number.isFinite(expiry) && expiry <= nowMs) {
    s.active = null;
    savePainFocusState(s);
    appendPainFocusAudit({
      ts: nowIso(),
      type: 'pain_focus_session_expired',
      session_id: normalizeText(active.id, ''),
      source: normalizeText(active.source, ''),
      task: normalizeText(active.task, '')
    });
    return { active: false, session: null, expired: true };
  }
  return { active: true, session: active, expired: false };
}

function getPainFocusStatus() {
  const state = loadPainFocusState();
  const active = activeFocusSession(state);
  return {
    ok: true,
    active: active.active === true,
    session: active.session || null,
    expired_cleared: active.expired === true,
    state_path: path.relative(ROOT, PAIN_FOCUS_STATE_PATH).replace(/\\/g, '/'),
    audit_path: path.relative(ROOT, PAIN_FOCUS_AUDIT_PATH).replace(/\\/g, '/')
  };
}

function startPainFocusSession(input = {}) {
  const policy = loadPainPolicy();
  const defaultTtl = Number(policy.focus_default_ttl_minutes || 30);
  const ttlMinutes = normalizeNumber(
    input.ttl_minutes,
    defaultTtl,
    1,
    Number(policy.focus_max_ttl_minutes || 240)
  );
  const startTs = nowIso();
  const expireTs = new Date(Date.now() + (ttlMinutes * 60 * 1000)).toISOString();
  const id = `PFOCUS-${sha16(`${startTs}|${normalizeText(input.task, 'focus_task')}|${normalizeText(input.source, 'unknown_source')}`)}`;
  const next = loadPainFocusState();
  next.active = {
    id,
    task: normalizeText(input.task, 'autonomy_execution').slice(0, 240),
    source: normalizeText(input.source, 'unknown_source').slice(0, 120),
    reason: normalizeText(input.reason, '').slice(0, 200),
    started_ts: startTs,
    expires_ts: expireTs
  };
  savePainFocusState(next);
  appendPainFocusAudit({
    ts: nowIso(),
    type: 'pain_focus_session_started',
    session_id: id,
    ttl_minutes: ttlMinutes,
    source: next.active.source,
    task: next.active.task,
    reason: next.active.reason || null
  });
  return {
    ok: true,
    session: next.active
  };
}

function stopPainFocusSession(input = {}) {
  const state = loadPainFocusState();
  const active = state && state.active && typeof state.active === 'object' ? state.active : null;
  if (!active) {
    return {
      ok: true,
      stopped: false,
      reason: 'no_active_session'
    };
  }
  const requestedId = normalizeText(input.session_id, '');
  if (requestedId && requestedId !== normalizeText(active.id, '')) {
    return {
      ok: true,
      stopped: false,
      reason: 'session_id_mismatch',
      active_session_id: normalizeText(active.id, '')
    };
  }
  const stopped = {
    id: normalizeText(active.id, ''),
    source: normalizeText(active.source, ''),
    task: normalizeText(active.task, ''),
    started_ts: normalizeText(active.started_ts, ''),
    expires_ts: normalizeText(active.expires_ts, '')
  };
  state.active = null;
  savePainFocusState(state);
  appendPainFocusAudit({
    ts: nowIso(),
    type: 'pain_focus_session_stopped',
    session_id: stopped.id,
    source: stopped.source,
    task: stopped.task,
    stop_reason: normalizeText(input.reason, 'manual_stop').slice(0, 160)
  });
  return {
    ok: true,
    stopped: true,
    session: stopped
  };
}

function includesPattern(text, patterns) {
  const raw = normalizeText(text, '').toLowerCase();
  if (!raw) return false;
  for (const pattern of patterns || []) {
    const token = normalizeText(pattern, '').toLowerCase();
    if (!token) continue;
    if (raw.includes(token)) return true;
  }
  return false;
}

function painDeferDecision(signal, prev, failureCountWindow) {
  const policy = loadPainPolicy();
  if (policy.defer_enabled !== true) {
    return { defer: false, reason: 'defer_policy_disabled', policy };
  }
  if (policy.defer_during_focus !== true) {
    return { defer: false, reason: 'focus_deferral_disabled', policy };
  }
  const focus = getPainFocusStatus();
  if (focus.active !== true || !focus.session) {
    return { defer: false, reason: 'no_focus_session', policy, focus };
  }
  const severity = normalizeSeverity(signal && signal.severity, 'medium');
  const risk = normalizeRisk(signal && signal.risk, 'medium');
  if (severityRank(severity) >= severityRank(policy.no_defer.min_severity)) {
    return { defer: false, reason: 'severity_non_deferrable', policy, focus };
  }
  if (riskRank(risk) >= riskRank(policy.no_defer.min_risk)) {
    return { defer: false, reason: 'risk_non_deferrable', policy, focus };
  }
  const code = normalizeText(signal && signal.code, '').toLowerCase();
  const source = normalizeText(signal && signal.source, '').toLowerCase();
  if (includesPattern(code, policy.no_defer.code_patterns)) {
    return { defer: false, reason: 'code_non_deferrable', policy, focus };
  }
  if (includesPattern(source, policy.no_defer.source_patterns)) {
    return { defer: false, reason: 'source_non_deferrable', policy, focus };
  }
  const forceAfter = Number(policy.force_escalate_after_window_failures || 0);
  if (forceAfter > 0 && Number(failureCountWindow || 0) >= forceAfter) {
    return { defer: false, reason: 'force_escalate_window_cap', policy, focus };
  }
  const deferCount = Number(prev && prev.defer_count || 0);
  const deferCap = Number(policy.defer_max_per_signature || 0);
  if (deferCap >= 0 && deferCount >= deferCap) {
    return { defer: false, reason: 'defer_cap_reached', policy, focus };
  }
  return {
    defer: true,
    reason: 'focus_session_active',
    policy,
    focus,
    defer_count: deferCount + 1
  };
}

function loadProposals(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const filePath = path.join(PROPOSALS_DIR, `${date}.json`);
  const raw = readJsonSafe(filePath, []);
  return {
    date,
    filePath,
    proposals: Array.isArray(raw) ? raw : []
  };
}

function saveProposals(filePath, proposals) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(Array.isArray(proposals) ? proposals : [], null, 2) + '\n', 'utf8');
}

function defaultSuggestedCommand(payload) {
  const source = normalizeText(payload.source, 'unknown_source');
  const code = normalizeText(payload.code, 'unknown_code');
  const summary = normalizeText(payload.summary, 'Investigate system failure');
  const task = `Diagnose persistent failure (${source}:${code}). ${summary}. Identify root cause, propose bounded fix, verify success, define rollback.`;
  const objectiveId = normalizeText(payload.objective_id, '');
  return `node systems/routing/route_execute.js --task="${task.replace(/"/g, '\\"')}" --tokens_est=1200 --repeats_14d=3 --errors_30d=1 --dry-run${objectiveId ? ` --id=${objectiveId}` : ''}`;
}

function buildPainProposal(payload, painRow, signature, failureCountWindow) {
  const date = todayStr(payload.ts || painRow.ts);
  const proposalId = `PAIN-${sha16(`${signature}|${date}`)}`;
  const source = normalizeText(payload.source, 'unknown_source');
  const subsystem = normalizeText(payload.subsystem, source);
  const code = normalizeText(payload.code, 'unknown_code');
  const titleDetail = normalizeText(payload.title, `${source} ${code}`).slice(0, 80);
  const summary = normalizeText(payload.summary, `Persistent failure detected in ${source}`);
  const suggestedNextCommand = normalizeText(payload.suggested_next_command, defaultSuggestedCommand(payload));
  const expectedImpact = normalizeRisk(payload.expected_impact, 'high');
  const risk = normalizeRisk(payload.risk, 'medium');
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.slice(0, 8) : [];

  if (evidence.length === 0) {
    evidence.push({
      source: 'pain_signal',
      path: path.relative(ROOT, PAIN_LOG_PATH).replace(/\\/g, '/'),
      match: `${source}:${code}:${signature}`,
      evidence_ref: `pain:${signature}`
    });
  }

  const validation = Array.isArray(payload.validation) && payload.validation.length > 0
    ? payload.validation.slice(0, 8).map((x) => String(x || '').trim()).filter(Boolean)
    : [
        'Identify a concrete root cause hypothesis tied to evidence',
        'Apply one bounded remediation with rollback plan',
        'Verify failure does not repeat in the next 2 runs'
      ];

  return {
    id: proposalId,
    type: normalizeText(payload.proposal_type, 'pain_signal_escalation'),
    title: `[Pain] ${titleDetail}`.slice(0, 120),
    summary: summary.slice(0, 320),
    expected_impact: expectedImpact,
    risk,
    validation,
    suggested_next_command: suggestedNextCommand,
    action_spec: {
      objective: `Diagnose and remediate recurring pain signal ${source}:${code} with bounded, reversible changes.`,
      target: `${subsystem}:${source}`,
      next_command: suggestedNextCommand,
      rollback: 'Revert touched files and restore previous stable config/runtime state.',
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
    evidence,
    meta: {
      source_eye: `pain_signal:${source}`.slice(0, 64),
      pain_signal: true,
      pain_signature: signature,
      pain_source: source,
      pain_subsystem: subsystem,
      pain_code: code,
      pain_failure_count_window: Number(failureCountWindow || 0),
      pain_severity: normalizeSeverity(payload.severity, 'medium'),
      objective_id: normalizeText(payload.objective_id, '') || null,
      requires_human_review: payload.manual_only === true,
      generated_at: nowIso()
    }
  };
}

function emitPainSignal(input = {}) {
  const ts = normalizeText(input.ts, nowIso());
  const source = normalizeText(input.source, 'unknown_source').slice(0, 96);
  const subsystem = normalizeText(input.subsystem, source).slice(0, 96);
  const code = normalizeText(input.code, 'unknown_code').slice(0, 96);
  const summary = normalizeText(input.summary, `${source}:${code}`).slice(0, 320);
  const details = normalizeText(input.details, '').slice(0, 1200);
  const severity = normalizeSeverity(input.severity, 'medium');
  const risk = normalizeRisk(input.risk, severity === 'critical' ? 'high' : 'medium');
  const signatureExtra = normalizeText(input.signature_extra, '').slice(0, 160);
  const signature = sha16(`${source}|${subsystem}|${code}|${signatureExtra}`);
  const windowHours = normalizeNumber(input.window_hours, 24, 1, 24 * 14);
  const escalateAfter = normalizeNumber(input.escalate_after, 2, 1, 100);
  const cooldownHours = normalizeNumber(input.cooldown_hours, 12, 1, 24 * 30);
  const proposalEnabled = input.create_proposal !== false;
  const nowMs = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  const state = loadPainState();
  if (!state.signatures || typeof state.signatures !== 'object') state.signatures = {};
  const prev = state.signatures[signature] && typeof state.signatures[signature] === 'object'
    ? state.signatures[signature]
    : {};
  const history = Array.isArray(prev.events) ? prev.events : [];
  const kept = history
    .map((row) => ({ ts: normalizeText(row && row.ts, ''), code: normalizeText(row && row.code, code) }))
    .filter((row) => {
      const ms = parseIsoMs(row.ts);
      return Number.isFinite(ms) && (nowMs - ms) <= windowMs;
    });
  kept.push({ ts, code });
  const failureCountWindow = kept.length;
  const totalCount = Number(prev.total_count || 0) + 1;
  const cooldownUntilMs = parseIsoMs(prev.cooldown_until_ts);
  const inCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs;
  const defer = painDeferDecision({
    source,
    subsystem,
    code,
    severity,
    risk
  }, prev, failureCountWindow);
  const shouldEscalate = proposalEnabled && !inCooldown && defer.defer !== true && failureCountWindow >= escalateAfter;
  const shouldRefreshProposal = (
    proposalEnabled
    && !inCooldown
    && defer.defer !== true
    && failureCountWindow >= escalateAfter
    && !!normalizeText(prev.last_proposal_id, '')
  );

  let escalation = {
    emitted: false,
    reason: shouldEscalate
      ? 'not_attempted'
      : (defer.defer === true
        ? String(defer.reason || 'deferred_focus')
        : (inCooldown ? 'cooldown_active' : 'below_threshold')),
    proposal_id: null,
    threshold: escalateAfter,
    window_hours: windowHours,
    failure_count_window: failureCountWindow,
    cooldown_until_ts: prev.cooldown_until_ts || null
  };

  const painRow = {
    ts,
    type: 'pain_signal',
    source,
    subsystem,
    code,
    summary,
    details,
    severity,
    risk,
    signature,
    signature_extra: signatureExtra || null,
    window_hours: windowHours,
    escalate_after: escalateAfter,
    failure_count_window: failureCountWindow,
    total_count: totalCount,
    create_proposal: proposalEnabled,
    deferred: defer.defer === true,
    defer_reason: defer.defer === true ? String(defer.reason || 'focus_session_active') : null,
    focus_session_id: defer && defer.focus && defer.focus.session
      ? normalizeText(defer.focus.session.id, '') || null
      : null
  };

  appendJsonl(PAIN_LOG_PATH, painRow);
  appendSystemHealthEvent({
    ts,
    type: 'system_health_event',
    source: source,
    subsystem: subsystem,
    code,
    severity,
    risk,
    summary: summary.slice(0, 220),
    details: details || null,
    signature,
    origin: 'pain_signal',
    failure_count_window: failureCountWindow,
    total_count: totalCount,
    create_proposal: proposalEnabled
  });

  if (shouldEscalate || shouldRefreshProposal) {
    const proposalsCtx = loadProposals(todayStr(ts));
    const proposal = buildPainProposal({
      ...input,
      source,
      subsystem,
      code,
      summary,
      risk
    }, painRow, signature, failureCountWindow);
    const proposalId = String(proposal.id || '');
    const idx = proposalsCtx.proposals.findIndex((p) => p && String(p.id || '') === proposalId);
    const exists = idx >= 0 ? proposalsCtx.proposals[idx] : null;
    if (!exists && shouldEscalate) {
      proposalsCtx.proposals.push(proposal);
      saveProposals(proposalsCtx.filePath, proposalsCtx.proposals);
      escalation = {
        emitted: true,
        reason: 'proposal_emitted',
        proposal_id: String(proposal.id || null),
        threshold: escalateAfter,
        window_hours: windowHours,
        failure_count_window: failureCountWindow,
        cooldown_until_ts: new Date(nowMs + cooldownMs).toISOString()
      };
    } else if (!exists) {
      escalation = {
        emitted: false,
        reason: 'proposal_missing_during_refresh',
        proposal_id: null,
        threshold: escalateAfter,
        window_hours: windowHours,
        failure_count_window: failureCountWindow,
        cooldown_until_ts: prev.cooldown_until_ts || null
      };
    } else {
      if (JSON.stringify(exists) !== JSON.stringify(proposal)) {
        proposalsCtx.proposals[idx] = proposal;
        saveProposals(proposalsCtx.filePath, proposalsCtx.proposals);
        escalation = {
          emitted: false,
          reason: shouldEscalate ? 'proposal_updated' : 'proposal_refreshed',
          proposal_id: proposalId,
          threshold: escalateAfter,
          window_hours: windowHours,
          failure_count_window: failureCountWindow,
          cooldown_until_ts: prev.cooldown_until_ts || null
        };
      } else {
        escalation = {
          emitted: false,
          reason: shouldEscalate ? 'proposal_exists' : 'proposal_current',
          proposal_id: String(exists.id || null),
          threshold: escalateAfter,
          window_hours: windowHours,
          failure_count_window: failureCountWindow,
          cooldown_until_ts: prev.cooldown_until_ts || null
        };
      }
    }
  }

  state.signatures[signature] = {
    source,
    subsystem,
    code,
    summary,
    details,
    severity,
    risk,
    signature,
    total_count: totalCount,
    events: kept.slice(-200),
    last_ts: ts,
    last_summary: summary,
    last_details: details || null,
    cooldown_until_ts: escalation.emitted === true
      ? escalation.cooldown_until_ts
      : (prev.cooldown_until_ts || null),
    last_escalation_ts: escalation.emitted === true ? nowIso() : (prev.last_escalation_ts || null),
    last_proposal_id: escalation.proposal_id || prev.last_proposal_id || null,
    defer_count: defer.defer === true
      ? Number(prev.defer_count || 0) + 1
      : (escalation.emitted === true ? 0 : Number(prev.defer_count || 0)),
    last_defer_ts: defer.defer === true ? nowIso() : (prev.last_defer_ts || null),
    last_defer_reason: defer.defer === true
      ? String(defer.reason || 'focus_session_active')
      : (prev.last_defer_reason || null),
    last_focus_session_id: defer.defer === true && defer && defer.focus && defer.focus.session
      ? normalizeText(defer.focus.session.id, '') || null
      : (prev.last_focus_session_id || null)
  };
  savePainState(state);

  appendJsonl(PAIN_LOG_PATH, {
    ts: nowIso(),
    type: 'pain_signal_decision',
    signature,
    source,
    subsystem,
    code,
    failure_count_window: failureCountWindow,
    total_count: totalCount,
    escalation,
    deferred: defer.defer === true,
    defer_reason: defer.defer === true ? String(defer.reason || 'focus_session_active') : null,
    focus_session_id: defer && defer.focus && defer.focus.session
      ? normalizeText(defer.focus.session.id, '') || null
      : null
  });

  appendSystemHealthEvent({
    ts: nowIso(),
    type: 'system_health_event',
    source: source,
    subsystem: subsystem,
    code: `${code}_decision`,
    severity: escalation.emitted === true ? 'high' : 'medium',
    risk: escalation.emitted === true ? 'high' : risk,
    summary: `pain_signal_decision ${source}:${code} ${escalation.reason}`.slice(0, 220),
    details: normalizeText(escalation.reason, '').slice(0, 240) || null,
    signature,
    origin: 'pain_signal_decision',
    escalation_emitted: escalation.emitted === true,
    escalation_reason: normalizeText(escalation.reason, '') || null,
    proposal_id: normalizeText(escalation.proposal_id, '') || null
  });

  return {
    ok: true,
    signal: painRow,
    escalation
  };
}

function status() {
  const state = loadPainState();
  const rows = Object.values(state.signatures || {});
  const nowMs = Date.now();
  const focus = getPainFocusStatus();
  const policy = loadPainPolicy();
  const activeCooldown = rows.filter((row) => {
    const ms = parseIsoMs(row && row.cooldown_until_ts);
    return Number.isFinite(ms) && ms > nowMs;
  }).length;
  return {
    ok: true,
    type: 'pain_signal_status',
    signatures: rows.length,
    active_cooldowns: activeCooldown,
    state_path: path.relative(ROOT, PAIN_STATE_PATH).replace(/\\/g, '/'),
    log_path: path.relative(ROOT, PAIN_LOG_PATH).replace(/\\/g, '/'),
    system_health_path: path.relative(ROOT, SYSTEM_HEALTH_EVENTS_PATH).replace(/\\/g, '/'),
    focus,
    policy: {
      defer_enabled: policy.defer_enabled === true,
      defer_during_focus: policy.defer_during_focus === true,
      defer_max_per_signature: Number(policy.defer_max_per_signature || 0),
      force_escalate_after_window_failures: Number(policy.force_escalate_after_window_failures || 0),
      no_defer: policy.no_defer
    }
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const i = String(arg).indexOf('=');
    if (i < 0) out[String(arg).slice(2)] = true;
    else out[String(arg).slice(2, i)] = String(arg).slice(i + 1);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      'Usage:\n' +
      '  node systems/autonomy/pain_signal.js status\n' +
      '  node systems/autonomy/pain_signal.js emit --source=... --code=... --summary="..."\n' +
      '  node systems/autonomy/pain_signal.js focus-start --task="..." [--ttl_minutes=N] [--source=...]\n' +
      '  node systems/autonomy/pain_signal.js focus-stop [--session_id=...] [--reason="..."]\n' +
      '  node systems/autonomy/pain_signal.js focus-status\n'
    );
    return;
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status()) + '\n');
    return;
  }
  if (cmd === 'emit') {
    const out = emitPainSignal({
      source: args.source,
      subsystem: args.subsystem,
      code: args.code,
      summary: args.summary,
      details: args.details,
      severity: args.severity,
      risk: args.risk,
      window_hours: args.window_hours,
      escalate_after: args.escalate_after,
      cooldown_hours: args.cooldown_hours,
      create_proposal: String(args.create_proposal || '1') !== '0'
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  if (cmd === 'focus-start') {
    const out = startPainFocusSession({
      task: args.task,
      ttl_minutes: args.ttl_minutes,
      source: args.source,
      reason: args.reason
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  if (cmd === 'focus-stop') {
    const out = stopPainFocusSession({
      session_id: args.session_id,
      reason: args.reason
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  if (cmd === 'focus-status') {
    process.stdout.write(JSON.stringify(getPainFocusStatus()) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown_command:${cmd}` }) + '\n');
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  emitPainSignal,
  status,
  startPainFocusSession,
  stopPainFocusSession,
  getPainFocusStatus
};

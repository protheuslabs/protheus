#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-069..077
 * Execution yield recovery lane.
 *
 * Closes observation->action conversion gaps via deterministic controls:
 * - Funnel SLO + dead-window detection
 * - Top-K reservation for high-worth open proposals
 * - Filter-pressure recovery + action_spec auto-enrichment
 * - Queue debt backpressure throttle publication
 * - Eye-health auto-heal/escalation receipts
 * - Execution floor enforcement + catch-up scheduling
 * - Shipped-outcome -> artifact bridge
 * - Adaptive escalation TTL with salvage path
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EXECUTION_YIELD_RECOVERY_POLICY_PATH
  ? path.resolve(process.env.EXECUTION_YIELD_RECOVERY_POLICY_PATH)
  : path.join(ROOT, 'config', 'execution_yield_recovery_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function normalizeDate(raw: unknown) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayUtc();
}

function normalizeToken(v: unknown, maxLen = 120) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseMs(tsRaw: unknown) {
  const ms = Date.parse(String(tsRaw || ''));
  return Number.isFinite(ms) ? ms : null;
}

function addUtcDays(dateStr: string, deltaDays: number) {
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return todayUtc();
  return new Date(ms + (deltaDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function dateWindow(endDate: string, days: number) {
  const out: string[] = [];
  const n = Math.max(1, days);
  for (let i = 0; i < n; i += 1) out.push(addUtcDays(endDate, -i));
  return out;
}

function sha256Object(v: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(v || {}), 'utf8').digest('hex');
}

function quantile(values: number[], q: number) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const clamped = Math.max(0, Math.min(1, q));
  const idx = Math.max(0, Math.min(nums.length - 1, Math.floor(clamped * (nums.length - 1))));
  return nums[idx];
}

function defaultPolicy() {
  return {
    schema_id: 'execution_yield_recovery_policy',
    schema_version: '1.0',
    enabled: true,
    strict_default: false,
    window_days: 14,
    dead_window_days: 7,
    paths: {
      queue_log_path: 'state/sensory/queue_log.jsonl',
      proposals_dir: 'state/sensory/proposals',
      decisions_dir: 'state/queue/decisions',
      eyes_registry_path: 'state/sensory/eyes/registry.json',
      latest_path: 'state/ops/execution_yield_recovery/latest.json',
      history_path: 'state/ops/execution_yield_recovery/history.jsonl',
      throttle_state_path: 'state/ops/execution_yield_recovery/intake_throttle.json',
      salvage_queue_path: 'state/ops/execution_yield_recovery/escalation_salvage.jsonl',
      eye_actions_history_path: 'state/ops/execution_yield_recovery/eye_actions.jsonl',
      artifact_state_path: 'state/ops/execution_yield_recovery/artifact_bridge_state.json'
    },
    top_k: {
      enabled: true,
      reserve_count: 2,
      min_score: 80,
      max_age_hours: 168
    },
    filter_rebalance: {
      enabled: true,
      high_score_threshold: 85,
      stale_defer_hours: 24,
      reasons: ['action_spec_missing', 'stale_open_age_sweep', 'composite_low']
    },
    queue_backpressure: {
      enabled: true,
      max_open: 140,
      max_open_p95_age_hours: 72,
      low_priority_score_threshold: 74
    },
    eye_health: {
      enabled: true,
      fail_streak_threshold: 2,
      error_rate_threshold: 0.7,
      max_auto_heal_attempts: 2
    },
    execution_floor: {
      enabled: true,
      min_shipped_per_day: 1,
      catchup_top_k: 2,
      observation_override: false
    },
    artifact_bridge: {
      enabled: true,
      mode: 'dopamine_log_artifact',
      command: [],
      directive: 'queue_outcome_shipped_v1'
    },
    escalation_ttl: {
      enabled: true,
      base_hours: 16,
      min_hours: 6,
      max_hours: 72,
      high_score_threshold: 85,
      high_score_factor: 2.0,
      low_score_threshold: 60,
      low_score_factor: 0.75,
      salvage_score_threshold: 85
    },
    event_stream: {
      enabled: true,
      script_path: 'systems/ops/event_sourced_control_plane.js',
      stream: 'ops',
      event: 'yield_recovery_tick'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const topKRaw = raw.top_k && typeof raw.top_k === 'object' ? raw.top_k : {};
  const frRaw = raw.filter_rebalance && typeof raw.filter_rebalance === 'object' ? raw.filter_rebalance : {};
  const bpRaw = raw.queue_backpressure && typeof raw.queue_backpressure === 'object' ? raw.queue_backpressure : {};
  const eyeRaw = raw.eye_health && typeof raw.eye_health === 'object' ? raw.eye_health : {};
  const floorRaw = raw.execution_floor && typeof raw.execution_floor === 'object' ? raw.execution_floor : {};
  const bridgeRaw = raw.artifact_bridge && typeof raw.artifact_bridge === 'object' ? raw.artifact_bridge : {};
  const escRaw = raw.escalation_ttl && typeof raw.escalation_ttl === 'object' ? raw.escalation_ttl : {};
  const streamRaw = raw.event_stream && typeof raw.event_stream === 'object' ? raw.event_stream : {};
  const reasons = Array.isArray(frRaw.reasons)
    ? frRaw.reasons.map((v: unknown) => normalizeToken(v, 100)).filter(Boolean)
    : base.filter_rebalance.reasons;
  const command = Array.isArray(bridgeRaw.command)
    ? bridgeRaw.command.map((v: unknown) => String(v || '').trim()).filter(Boolean)
    : [];
  return {
    schema_id: 'execution_yield_recovery_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    window_days: clampInt(raw.window_days, 1, 365, base.window_days),
    dead_window_days: clampInt(raw.dead_window_days, 1, 365, base.dead_window_days),
    paths: {
      queue_log_path: resolvePath(pathsRaw.queue_log_path, base.paths.queue_log_path),
      proposals_dir: resolvePath(pathsRaw.proposals_dir, base.paths.proposals_dir),
      decisions_dir: resolvePath(pathsRaw.decisions_dir, base.paths.decisions_dir),
      eyes_registry_path: resolvePath(pathsRaw.eyes_registry_path, base.paths.eyes_registry_path),
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      history_path: resolvePath(pathsRaw.history_path, base.paths.history_path),
      throttle_state_path: resolvePath(pathsRaw.throttle_state_path, base.paths.throttle_state_path),
      salvage_queue_path: resolvePath(pathsRaw.salvage_queue_path, base.paths.salvage_queue_path),
      eye_actions_history_path: resolvePath(pathsRaw.eye_actions_history_path, base.paths.eye_actions_history_path),
      artifact_state_path: resolvePath(pathsRaw.artifact_state_path, base.paths.artifact_state_path)
    },
    top_k: {
      enabled: toBool(topKRaw.enabled, base.top_k.enabled),
      reserve_count: clampInt(topKRaw.reserve_count, 0, 100, base.top_k.reserve_count),
      min_score: clampNumber(topKRaw.min_score, 0, 100, base.top_k.min_score),
      max_age_hours: clampNumber(topKRaw.max_age_hours, 1, 24 * 365, base.top_k.max_age_hours)
    },
    filter_rebalance: {
      enabled: toBool(frRaw.enabled, base.filter_rebalance.enabled),
      high_score_threshold: clampNumber(frRaw.high_score_threshold, 0, 100, base.filter_rebalance.high_score_threshold),
      stale_defer_hours: clampNumber(frRaw.stale_defer_hours, 1, 24 * 30, base.filter_rebalance.stale_defer_hours),
      reasons: reasons.length ? reasons : base.filter_rebalance.reasons
    },
    queue_backpressure: {
      enabled: toBool(bpRaw.enabled, base.queue_backpressure.enabled),
      max_open: clampInt(bpRaw.max_open, 1, 100000, base.queue_backpressure.max_open),
      max_open_p95_age_hours: clampNumber(
        bpRaw.max_open_p95_age_hours,
        1,
        24 * 365,
        base.queue_backpressure.max_open_p95_age_hours
      ),
      low_priority_score_threshold: clampNumber(
        bpRaw.low_priority_score_threshold,
        0,
        100,
        base.queue_backpressure.low_priority_score_threshold
      )
    },
    eye_health: {
      enabled: toBool(eyeRaw.enabled, base.eye_health.enabled),
      fail_streak_threshold: clampInt(eyeRaw.fail_streak_threshold, 1, 1000, base.eye_health.fail_streak_threshold),
      error_rate_threshold: clampNumber(eyeRaw.error_rate_threshold, 0, 1, base.eye_health.error_rate_threshold),
      max_auto_heal_attempts: clampInt(eyeRaw.max_auto_heal_attempts, 0, 1000, base.eye_health.max_auto_heal_attempts)
    },
    execution_floor: {
      enabled: toBool(floorRaw.enabled, base.execution_floor.enabled),
      min_shipped_per_day: clampInt(floorRaw.min_shipped_per_day, 0, 1000, base.execution_floor.min_shipped_per_day),
      catchup_top_k: clampInt(floorRaw.catchup_top_k, 0, 100, base.execution_floor.catchup_top_k),
      observation_override: toBool(floorRaw.observation_override, base.execution_floor.observation_override)
    },
    artifact_bridge: {
      enabled: toBool(
        process.env.YIELD_RECOVERY_ARTIFACT_BRIDGE_ENABLED,
        toBool(bridgeRaw.enabled, base.artifact_bridge.enabled)
      ),
      mode: normalizeToken(bridgeRaw.mode || base.artifact_bridge.mode, 60) || base.artifact_bridge.mode,
      command,
      directive: cleanText(bridgeRaw.directive || base.artifact_bridge.directive, 120) || base.artifact_bridge.directive
    },
    escalation_ttl: {
      enabled: toBool(escRaw.enabled, base.escalation_ttl.enabled),
      base_hours: clampNumber(escRaw.base_hours, 1, 24 * 365, base.escalation_ttl.base_hours),
      min_hours: clampNumber(escRaw.min_hours, 1, 24 * 365, base.escalation_ttl.min_hours),
      max_hours: clampNumber(escRaw.max_hours, 1, 24 * 365, base.escalation_ttl.max_hours),
      high_score_threshold: clampNumber(escRaw.high_score_threshold, 0, 100, base.escalation_ttl.high_score_threshold),
      high_score_factor: clampNumber(escRaw.high_score_factor, 0.1, 10, base.escalation_ttl.high_score_factor),
      low_score_threshold: clampNumber(escRaw.low_score_threshold, 0, 100, base.escalation_ttl.low_score_threshold),
      low_score_factor: clampNumber(escRaw.low_score_factor, 0.1, 10, base.escalation_ttl.low_score_factor),
      salvage_score_threshold: clampNumber(
        escRaw.salvage_score_threshold,
        0,
        100,
        base.escalation_ttl.salvage_score_threshold
      )
    },
    event_stream: {
      enabled: toBool(streamRaw.enabled, base.event_stream.enabled),
      script_path: resolvePath(streamRaw.script_path, base.event_stream.script_path),
      stream: normalizeToken(streamRaw.stream || base.event_stream.stream, 64) || base.event_stream.stream,
      event: normalizeToken(streamRaw.event || base.event_stream.event, 64) || base.event_stream.event
    },
    policy_path: path.resolve(policyPath)
  };
}

function readDecisionEvents(decisionsDir: string, dates: string[]) {
  const out: AnyObj[] = [];
  for (const date of dates) {
    const rows = readJsonl(path.join(decisionsDir, `${date}.jsonl`));
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      out.push({ ...row, __date: date });
    }
  }
  return out;
}

function loadQueueEvents(queueLogPath: string) {
  return readJsonl(queueLogPath)
    .filter((row: AnyObj) => row && typeof row === 'object')
    .sort((a: AnyObj, b: AnyObj) => {
      const ta = parseMs(a.ts) || 0;
      const tb = parseMs(b.ts) || 0;
      return ta - tb;
    });
}

function normalizeProposalsShape(raw: unknown) {
  if (Array.isArray(raw)) {
    return {
      proposals: raw,
      write(next: AnyObj[]) { return next; }
    };
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as AnyObj).proposals)) {
    return {
      proposals: (raw as AnyObj).proposals,
      write(next: AnyObj[]) { return { ...(raw as AnyObj), proposals: next }; }
    };
  }
  return null;
}

function loadProposalsCatalog(proposalsDir: string, dates: string[]) {
  const byId = new Map<string, AnyObj>();
  const files = new Map<string, AnyObj>();
  for (const date of dates) {
    const filePath = path.join(proposalsDir, `${date}.json`);
    if (!fs.existsSync(filePath)) continue;
    const raw = readJson(filePath, null);
    const shaped = normalizeProposalsShape(raw);
    if (!shaped) continue;
    const rows = Array.isArray(shaped.proposals) ? shaped.proposals : [];
    const holder = {
      file_path: filePath,
      date,
      rows: rows.slice(),
      write: shaped.write,
      changed: false
    };
    files.set(filePath, holder);
    for (let i = 0; i < holder.rows.length; i += 1) {
      const row = holder.rows[i];
      if (!row || typeof row !== 'object') continue;
      const id = String((row as AnyObj).id || '').trim();
      if (!id) continue;
      const current = byId.get(id);
      if (!current || String(current.date || '') <= String(date)) {
        byId.set(id, {
          id,
          date,
          file_path: filePath,
          index: i,
          proposal: row
        });
      }
    }
  }
  return { byId, files };
}

function writeProposalMutations(files: Map<string, AnyObj>) {
  let filesChanged = 0;
  for (const holder of files.values()) {
    if (!holder.changed) continue;
    const payload = holder.write(holder.rows);
    fs.writeFileSync(holder.file_path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    filesChanged += 1;
  }
  return filesChanged;
}

function extractExecutionScoreFromMeta(meta: AnyObj) {
  if (!meta || typeof meta !== 'object') return null;
  const candidates = [
    meta.execution_worthiness_score,
    meta.execution_worthiness,
    meta.score,
    meta.actionability_score,
    meta.composite_eligibility_score,
    meta.signal_quality_score
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }
  const admission = meta.admission_preview && typeof meta.admission_preview === 'object'
    ? meta.admission_preview
    : null;
  if (admission) {
    const n = Number(admission.execution_worthiness_score || admission.composite_score || admission.score);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }
  return null;
}

function inferExecutionScore(proposal: AnyObj, queueHint: AnyObj = null) {
  const direct = Number(proposal && proposal.execution_worthiness_score);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
  const metaScore = extractExecutionScoreFromMeta(proposal && proposal.meta);
  if (metaScore != null) return metaScore;
  const hint = Number(queueHint && queueHint.execution_score);
  if (Number.isFinite(hint)) return Math.max(0, Math.min(100, hint));
  const hasAction = proposal && proposal.action_spec && typeof proposal.action_spec === 'object';
  const hasCmd = cleanText(
    proposal && (
      proposal.suggested_next_command
      || (hasAction ? proposal.action_spec.next_command : '')
    ),
    400
  );
  const hasVerify = Array.isArray(hasAction && proposal.action_spec.verify)
    ? proposal.action_spec.verify.length > 0
    : false;
  const hasRollback = cleanText(hasAction && proposal.action_spec.rollback, 400).length > 0;
  let base = 40;
  if (hasAction) base += 20;
  if (hasCmd) base += 15;
  if (hasVerify) base += 15;
  if (hasRollback) base += 10;
  return Math.max(0, Math.min(100, base));
}

function buildQueueState(queueEvents: AnyObj[]) {
  const byId = new Map<string, AnyObj>();
  for (const row of queueEvents) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.proposal_id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    const type = normalizeToken(row.type || '', 64);
    if (!type) continue;
    const prev = byId.get(id) || {
      proposal_id: id,
      status: 'open',
      first_generated_ts: null,
      last_event_ts: null,
      title: null,
      proposal_hash: null,
      execution_score: null,
      filter_reason: null,
      generated_date: null
    };
    const ts = row.ts || prev.last_event_ts || nowIso();
    prev.last_event_ts = ts;
    if (row.title) prev.title = String(row.title).slice(0, 220);
    if (row.proposal_hash) prev.proposal_hash = String(row.proposal_hash);
    if (Number.isFinite(Number(row.execution_worthiness_score))) {
      prev.execution_score = Math.max(0, Math.min(100, Number(row.execution_worthiness_score)));
    }
    if (type === 'proposal_generated') {
      prev.status = 'open';
      prev.generated_date = String(row.date || prev.generated_date || '').slice(0, 10) || null;
      if (!prev.first_generated_ts) prev.first_generated_ts = ts;
      prev.filter_reason = null;
    } else if (type === 'proposal_accepted') {
      prev.status = 'accepted';
      prev.filter_reason = null;
    } else if (type === 'proposal_done') {
      prev.status = 'done';
      prev.filter_reason = null;
    } else if (type === 'proposal_rejected') {
      prev.status = 'rejected';
      prev.filter_reason = String(row.reason || prev.filter_reason || '').slice(0, 180) || null;
    } else if (type === 'proposal_filtered') {
      prev.status = 'filtered';
      prev.filter_reason = String(row.filter_reason || row.reason || prev.filter_reason || '').slice(0, 180) || null;
    } else if (type === 'proposal_snoozed') {
      const untilMs = parseMs(row.snooze_until);
      if (untilMs != null && untilMs > Date.now()) prev.status = 'snoozed';
      else prev.status = 'open';
    }
    byId.set(id, prev);
  }
  return byId;
}

function openQueueRows(queueState: Map<string, AnyObj>, proposalCatalogById: Map<string, AnyObj>, nowMs: number) {
  const out: AnyObj[] = [];
  for (const row of queueState.values()) {
    const status = normalizeToken(row.status || '', 40);
    if (status !== 'open') continue;
    const proposalRef = proposalCatalogById.get(String(row.proposal_id || '')) || null;
    const proposal = proposalRef && proposalRef.proposal ? proposalRef.proposal : null;
    const generatedMs = parseMs(row.first_generated_ts || row.last_event_ts);
    const ageHours = generatedMs == null ? 0 : Math.max(0, (nowMs - generatedMs) / (1000 * 60 * 60));
    const score = inferExecutionScore(proposal || {}, row);
    out.push({
      proposal_id: String(row.proposal_id),
      status: 'open',
      age_hours: Number(ageHours.toFixed(3)),
      score: Number(score.toFixed(3)),
      generated_ts: row.first_generated_ts || row.last_event_ts || null,
      title: row.title || (proposal && proposal.title) || null,
      type: normalizeToken((proposal && (proposal.type || proposal.proposal_type)) || '', 80) || 'unknown',
      proposal: proposal || null,
      proposal_ref: proposalRef || null
    });
  }
  return out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.age_hours !== a.age_hours) return b.age_hours - a.age_hours;
    return String(a.proposal_id || '').localeCompare(String(b.proposal_id || ''));
  });
}

function appendQueueEvent(queueLogPath: string, event: AnyObj) {
  appendJsonl(queueLogPath, {
    ts: nowIso(),
    source: 'execution_yield_recovery',
    ...event
  });
}

function appendDecisionEvent(decisionsDir: string, date: string, event: AnyObj) {
  appendJsonl(path.join(decisionsDir, `${date}.jsonl`), {
    ts: nowIso(),
    source: 'execution_yield_recovery',
    ...event
  });
}

function computeFunnel(
  queueEvents: AnyObj[],
  decisionEvents: AnyObj[],
  startMs: number,
  endMs: number
) {
  let detected = 0;
  let accepted = 0;
  let executed = 0;
  let shipped = 0;
  for (const row of queueEvents) {
    const ts = parseMs(row && row.ts);
    if (ts == null || ts < startMs || ts > endMs) continue;
    const type = normalizeToken(row && row.type || '', 80);
    if (type === 'proposal_generated') detected += 1;
    if (type === 'proposal_accepted') accepted += 1;
    if (type === 'proposal_done') executed += 1;
  }
  for (const row of decisionEvents) {
    const ts = parseMs(row && row.ts);
    if (ts == null || ts < startMs || ts > endMs) continue;
    const type = normalizeToken(row && row.type || '', 80);
    if (type === 'decision' && normalizeToken(row && row.decision || '', 40) === 'accept') accepted += 1;
    if (type === 'outcome') {
      executed += 1;
      if (normalizeToken(row && row.outcome || '', 40) === 'shipped') shipped += 1;
    }
  }
  return {
    detected,
    accepted,
    executed,
    shipped,
    accepted_per_detected: detected > 0 ? Number((accepted / detected).toFixed(4)) : 0,
    executed_per_accepted: accepted > 0 ? Number((executed / accepted).toFixed(4)) : 0,
    shipped_per_executed: executed > 0 ? Number((shipped / executed).toFixed(4)) : 0
  };
}

function detectDeadWindow(decisionEvents: AnyObj[], startMs: number, endMs: number) {
  let shipped = 0;
  for (const row of decisionEvents) {
    const ts = parseMs(row && row.ts);
    if (ts == null || ts < startMs || ts > endMs) continue;
    if (normalizeToken(row && row.type || '', 80) !== 'outcome') continue;
    if (normalizeToken(row && row.outcome || '', 40) === 'shipped') shipped += 1;
  }
  return {
    dead_window: shipped === 0,
    shipped
  };
}

function synthesizeActionSpec(proposal: AnyObj) {
  const title = cleanText(proposal && proposal.title, 180) || 'proposal';
  const cmd = cleanText(
    proposal && (
      proposal.suggested_next_command
      || (proposal.action_spec && proposal.action_spec.next_command)
      || ''
    ),
    300
  ) || 'node habits/scripts/proposal_queue.js metrics';
  return {
    version: 1,
    objective: `Convert queued proposal into executable, measurable action: ${title}`,
    target: `proposal:${cleanText(proposal && proposal.id, 80) || normalizeToken(title, 40)}`,
    next_command: cmd,
    verify: [
      'queue outcome is logged with evidence',
      'execution emits measurable artifact or receipt'
    ],
    rollback: 'revert queue status transition and restore prior proposal metadata snapshot'
  };
}

function recoverFilteredHighScore(
  policy: AnyObj,
  queueLogPath: string,
  decisionDir: string,
  date: string,
  queueEvents: AnyObj[],
  queueState: Map<string, AnyObj>,
  proposalCatalog: { byId: Map<string, AnyObj>, files: Map<string, AnyObj> },
  apply: boolean
) {
  const enabled = policy.filter_rebalance && policy.filter_rebalance.enabled === true;
  if (!enabled) return { enabled: false, candidates: 0, recovered: [], files_changed: 0 };
  const allowedReasons = new Set((policy.filter_rebalance.reasons || []).map((r: unknown) => normalizeToken(r, 120)));
  const threshold = Number(policy.filter_rebalance.high_score_threshold || 85);
  const staleDeferHours = Number(policy.filter_rebalance.stale_defer_hours || 24);
  const latestFiltered = new Map<string, AnyObj>();
  for (const row of queueEvents) {
    if (!row || typeof row !== 'object') continue;
    if (normalizeToken(row.type || '', 80) !== 'proposal_filtered') continue;
    const id = String(row.proposal_id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    latestFiltered.set(id, row);
  }
  const recovered: AnyObj[] = [];
  for (const [proposalId, row] of latestFiltered.entries()) {
    const reason = normalizeToken(row.filter_reason || row.reason || '', 140);
    if (!allowedReasons.has(reason)) continue;
    const score = Number.isFinite(Number(row.execution_worthiness_score))
      ? Number(row.execution_worthiness_score)
      : Number(queueState.get(proposalId)?.execution_score || 0);
    if (!Number.isFinite(score) || score < threshold) continue;
    const proposalRef = proposalCatalog.byId.get(proposalId);
    const proposal = proposalRef && proposalRef.proposal ? proposalRef.proposal : null;
    if (reason === 'action_spec_missing' && proposalRef && proposal && typeof proposal === 'object') {
      if (!(proposal.action_spec && typeof proposal.action_spec === 'object')) {
        proposal.action_spec = synthesizeActionSpec(proposal);
        const holder = proposalCatalog.files.get(proposalRef.file_path);
        if (holder) {
          holder.rows[proposalRef.index] = proposal;
          holder.changed = true;
        }
      }
      const hash = sha256Object(proposal);
      if (apply) {
        appendQueueEvent(queueLogPath, {
          type: 'proposal_generated',
          date,
          proposal_id: proposalId,
          title: cleanText(proposal.title || row.title || 'Untitled', 220),
          proposal_hash: hash,
          status_after: 'open',
          recovered_from_filter_reason: reason,
          execution_worthiness_score: Number(score.toFixed(3))
        });
      }
      recovered.push({
        proposal_id: proposalId,
        lane: 'rewrite',
        reason,
        score: Number(score.toFixed(3)),
        action_spec_enriched: true,
        requeued: apply
      });
      continue;
    }
    if (reason === 'stale_open_age_sweep') {
      if (apply) {
        appendQueueEvent(queueLogPath, {
          type: 'proposal_snoozed',
          date,
          proposal_id: proposalId,
          title: cleanText(row.title || 'Untitled', 220),
          proposal_hash: row.proposal_hash || null,
          status_after: 'snoozed',
          snooze_until: addUtcDays(date, Math.max(1, Math.ceil(staleDeferHours / 24))),
          note: `yield_recovery defer stale high-score ${Number(score.toFixed(1))}`
        });
      }
      recovered.push({
        proposal_id: proposalId,
        lane: 'defer',
        reason,
        score: Number(score.toFixed(3)),
        deferred: apply
      });
      continue;
    }
    if (reason === 'composite_low') {
      if (apply) {
        appendDecisionEvent(decisionDir, date, {
          type: 'decision',
          proposal_id: proposalId,
          decision: 'park',
          reason: `yield_recovery_escalate composite_low score=${Number(score.toFixed(1))}`
        });
      }
      recovered.push({
        proposal_id: proposalId,
        lane: 'escalate',
        reason,
        score: Number(score.toFixed(3)),
        escalated: apply
      });
    }
  }
  const filesChanged = apply ? writeProposalMutations(proposalCatalog.files) : Number(
    Array.from(proposalCatalog.files.values()).filter((row) => row.changed).length
  );
  return {
    enabled: true,
    candidates: latestFiltered.size,
    recovered,
    files_changed: filesChanged
  };
}

function reserveTopK(
  policy: AnyObj,
  date: string,
  queueLogPath: string,
  decisionsDir: string,
  openRows: AnyObj[],
  apply: boolean,
  alreadyReserved = new Set<string>()
) {
  const cfg = policy.top_k || {};
  if (cfg.enabled !== true || Number(cfg.reserve_count || 0) <= 0) {
    return { enabled: false, planned: [], applied: [] };
  }
  const limit = Math.max(0, Number(cfg.reserve_count || 0));
  const minScore = Number(cfg.min_score || 80);
  const maxAgeHours = Number(cfg.max_age_hours || 168);
  const planned = openRows
    .filter((row) => Number(row.score || 0) >= minScore && Number(row.age_hours || 0) <= maxAgeHours)
    .filter((row) => !alreadyReserved.has(String(row.proposal_id || '')))
    .slice(0, limit)
    .map((row) => ({
      proposal_id: row.proposal_id,
      score: Number(Number(row.score || 0).toFixed(3)),
      age_hours: Number(Number(row.age_hours || 0).toFixed(3)),
      reason: `yield_recovery_top_k score=${Number(Number(row.score || 0).toFixed(1))}`
    }));
  const applied: AnyObj[] = [];
  if (apply) {
    for (const item of planned) {
      appendQueueEvent(queueLogPath, {
        type: 'proposal_accepted',
        date,
        proposal_id: item.proposal_id,
        status_after: 'accepted',
        note: item.reason
      });
      appendDecisionEvent(decisionsDir, date, {
        type: 'decision',
        proposal_id: item.proposal_id,
        decision: 'accept',
        reason: item.reason
      });
      applied.push(item);
      alreadyReserved.add(String(item.proposal_id || ''));
    }
  }
  return { enabled: true, planned, applied };
}

function resolveThrottleState(policy: AnyObj, openRows: AnyObj[], apply: boolean) {
  const cfg = policy.queue_backpressure || {};
  if (cfg.enabled !== true) {
    return {
      enabled: false,
      triggered: false,
      open_count: openRows.length,
      p95_open_age_hours: null
    };
  }
  const ages = openRows.map((row) => Number(row.age_hours || 0)).filter((n) => Number.isFinite(n));
  const p95 = quantile(ages, 0.95);
  const maxOpen = Number(cfg.max_open || 0);
  const maxAge = Number(cfg.max_open_p95_age_hours || 0);
  const triggered = Number(openRows.length) > maxOpen || (p95 != null && Number(p95) > maxAge);
  const state = {
    schema_id: 'execution_yield_recovery_throttle',
    schema_version: '1.0',
    ts: nowIso(),
    enabled: triggered,
    reason_codes: [
      ...(Number(openRows.length) > maxOpen ? ['open_count_exceeds_threshold'] : []),
      ...((p95 != null && Number(p95) > maxAge) ? ['open_age_p95_exceeds_threshold'] : [])
    ],
    thresholds: {
      max_open: maxOpen,
      max_open_p95_age_hours: maxAge,
      low_priority_score_threshold: Number(cfg.low_priority_score_threshold || 0)
    },
    queue: {
      open_count: openRows.length,
      p95_open_age_hours: p95 == null ? null : Number(Number(p95).toFixed(3))
    }
  };
  if (apply) writeJsonAtomic(policy.paths.throttle_state_path, state);
  return {
    enabled: true,
    triggered,
    open_count: openRows.length,
    p95_open_age_hours: state.queue.p95_open_age_hours,
    low_priority_score_threshold: state.thresholds.low_priority_score_threshold,
    state_path: relPath(policy.paths.throttle_state_path),
    state
  };
}

function classifyEyeHealth(policy: AnyObj, apply: boolean) {
  const cfg = policy.eye_health || {};
  if (cfg.enabled !== true) return { enabled: false, actions: [] };
  const registry = readJson(policy.paths.eyes_registry_path, {});
  const eyes = Array.isArray(registry && registry.eyes) ? registry.eyes : [];
  const actions: AnyObj[] = [];
  for (const eye of eyes) {
    if (!eye || typeof eye !== 'object') continue;
    const eyeId = cleanText(eye.id, 120);
    if (!eyeId) continue;
    const failures = Math.max(0, Number(eye.consecutive_failures || 0));
    const errorRate = Math.max(0, Number(eye.error_rate || 0));
    const status = normalizeToken(eye.status || '', 80);
    const quarantineUntilMs = parseMs(eye.health_quarantine_until || eye.quarantine_until);
    const quarantineActive = quarantineUntilMs != null && quarantineUntilMs > Date.now();
    const degraded = failures >= Number(cfg.fail_streak_threshold || 2)
      || errorRate >= Number(cfg.error_rate_threshold || 0.7)
      || quarantineActive
      || status === 'degraded';
    if (!degraded) continue;
    const selfHealAttempts = Math.max(0, Number(eye.self_heal_attempts || 0));
    const action = selfHealAttempts < Number(cfg.max_auto_heal_attempts || 2)
      ? 'auto_heal_retry'
      : 'escalate_human';
    const row = {
      ts: nowIso(),
      eye_id: eyeId,
      action,
      failures,
      error_rate: Number(errorRate.toFixed(4)),
      status: status || null,
      quarantine_active: quarantineActive,
      reason: action === 'auto_heal_retry'
        ? 'eye_health_degraded_retry_window'
        : 'eye_health_degraded_requires_escalation'
    };
    actions.push(row);
    if (apply) appendJsonl(policy.paths.eye_actions_history_path, row);
  }
  return {
    enabled: true,
    actions_count: actions.length,
    actions: actions.slice(0, 50),
    history_path: relPath(policy.paths.eye_actions_history_path)
  };
}

function isEscalationType(row: AnyObj) {
  const t = normalizeToken(row && (row.type || row.proposal_type) || '', 120);
  if (!t) return false;
  return t.includes('escalation') || t.startsWith('pain');
}

function adaptiveEscalationTtlHours(policy: AnyObj, score: number) {
  const cfg = policy.escalation_ttl || {};
  const base = Number(cfg.base_hours || 16);
  const highThreshold = Number(cfg.high_score_threshold || 85);
  const lowThreshold = Number(cfg.low_score_threshold || 60);
  let factor = 1;
  if (Number(score) >= highThreshold) factor = Number(cfg.high_score_factor || 2);
  else if (Number(score) <= lowThreshold) factor = Number(cfg.low_score_factor || 0.75);
  const raw = base * factor;
  return clampNumber(
    raw,
    Number(cfg.min_hours || 6),
    Number(cfg.max_hours || 72),
    base
  );
}

function handleAdaptiveEscalationTtl(
  policy: AnyObj,
  date: string,
  queueLogPath: string,
  decisionsDir: string,
  openRows: AnyObj[],
  apply: boolean
) {
  const cfg = policy.escalation_ttl || {};
  if (cfg.enabled !== true) return { enabled: false, salvage: [], rejected: [] };
  const salvageThreshold = Number(cfg.salvage_score_threshold || 85);
  const salvage: AnyObj[] = [];
  const rejected: AnyObj[] = [];
  for (const row of openRows) {
    if (!isEscalationType(row)) continue;
    const score = Number(row.score || 0);
    const age = Number(row.age_hours || 0);
    const ttl = adaptiveEscalationTtlHours(policy, score);
    if (age <= ttl) continue;
    const item = {
      proposal_id: row.proposal_id,
      score: Number(score.toFixed(3)),
      age_hours: Number(age.toFixed(3)),
      adaptive_ttl_hours: Number(ttl.toFixed(3))
    };
    if (score >= salvageThreshold) salvage.push(item);
    else rejected.push(item);
  }

  if (apply) {
    for (const item of salvage) {
      const until = addUtcDays(date, 1);
      appendQueueEvent(queueLogPath, {
        type: 'proposal_snoozed',
        date,
        proposal_id: item.proposal_id,
        status_after: 'snoozed',
        snooze_until: until,
        note: `adaptive_escalation_ttl_salvage score=${Number(item.score.toFixed(1))} age_h=${Number(item.age_hours.toFixed(1))}`
      });
      appendDecisionEvent(decisionsDir, date, {
        type: 'decision',
        proposal_id: item.proposal_id,
        decision: 'park',
        reason: `adaptive_escalation_ttl_salvage ttl_h=${Number(item.adaptive_ttl_hours.toFixed(1))}`
      });
      appendJsonl(policy.paths.salvage_queue_path, {
        ts: nowIso(),
        proposal_id: item.proposal_id,
        score: item.score,
        age_hours: item.age_hours,
        adaptive_ttl_hours: item.adaptive_ttl_hours,
        action: 'salvaged'
      });
    }
    for (const item of rejected) {
      appendQueueEvent(queueLogPath, {
        type: 'proposal_rejected',
        date,
        proposal_id: item.proposal_id,
        status_after: 'rejected',
        reason: `adaptive_escalation_ttl_expired ttl_h=${Number(item.adaptive_ttl_hours.toFixed(1))} score=${Number(item.score.toFixed(1))}`
      });
      appendDecisionEvent(decisionsDir, date, {
        type: 'decision',
        proposal_id: item.proposal_id,
        decision: 'reject',
        reason: `adaptive_escalation_ttl_expired ttl_h=${Number(item.adaptive_ttl_hours.toFixed(1))}`
      });
    }
  }
  return {
    enabled: true,
    salvage_count: salvage.length,
    reject_count: rejected.length,
    salvage: salvage.slice(0, 50),
    rejected: rejected.slice(0, 50),
    salvage_path: relPath(policy.paths.salvage_queue_path)
  };
}

function evaluateExecutionFloor(
  policy: AnyObj,
  date: string,
  decisionEventsToday: AnyObj[],
  openRows: AnyObj[],
  apply: boolean,
  queueLogPath: string,
  decisionsDir: string,
  reservedSet: Set<string>
) {
  const cfg = policy.execution_floor || {};
  if (cfg.enabled !== true) return { enabled: false };
  const shippedToday = decisionEventsToday.filter((row) => (
    normalizeToken(row && row.type || '', 40) === 'outcome'
    && normalizeToken(row && row.outcome || '', 40) === 'shipped'
  )).length;
  const minShipped = Math.max(0, Number(cfg.min_shipped_per_day || 0));
  const observationOverride = cfg.observation_override === true;
  const miss = !observationOverride && shippedToday < minShipped;
  const catchupCount = miss ? Math.max(0, Number(cfg.catchup_top_k || 0)) : 0;
  const planned = catchupCount > 0
    ? openRows
      .filter((row) => !reservedSet.has(String(row.proposal_id || '')))
      .slice(0, catchupCount)
      .map((row) => ({
        proposal_id: row.proposal_id,
        score: Number(Number(row.score || 0).toFixed(3)),
        reason: `execution_floor_catchup shipped_today=${shippedToday} min=${minShipped}`
      }))
    : [];
  const applied: AnyObj[] = [];
  if (apply) {
    for (const item of planned) {
      appendQueueEvent(queueLogPath, {
        type: 'proposal_accepted',
        date,
        proposal_id: item.proposal_id,
        status_after: 'accepted',
        note: item.reason
      });
      appendDecisionEvent(decisionsDir, date, {
        type: 'decision',
        proposal_id: item.proposal_id,
        decision: 'accept',
        reason: item.reason
      });
      applied.push(item);
      reservedSet.add(String(item.proposal_id || ''));
    }
  }
  return {
    enabled: true,
    shipped_today: shippedToday,
    min_shipped_per_day: minShipped,
    observation_override: observationOverride,
    miss_floor: miss,
    catchup_planned: planned,
    catchup_applied: applied
  };
}

function runArtifactBridge(
  policy: AnyObj,
  date: string,
  decisionEventsToday: AnyObj[],
  apply: boolean
) {
  const cfg = policy.artifact_bridge || {};
  if (cfg.enabled !== true) return { enabled: false };
  const state = readJson(policy.paths.artifact_state_path, {
    schema_id: 'execution_yield_recovery_artifact_state',
    schema_version: '1.0',
    captured_keys: []
  });
  const captured = new Set(
    Array.isArray(state && state.captured_keys)
      ? state.captured_keys.map((v: unknown) => cleanText(v, 220)).filter(Boolean)
      : []
  );
  const shipped = decisionEventsToday.filter((row) => (
    normalizeToken(row && row.type || '', 40) === 'outcome'
    && normalizeToken(row && row.outcome || '', 40) === 'shipped'
  ));
  const planned: AnyObj[] = [];
  const bridged: AnyObj[] = [];
  for (const row of shipped) {
    const proposalId = cleanText(row.proposal_id, 120);
    if (!proposalId) continue;
    const evidenceRef = cleanText(row.evidence_ref, 220) || 'queue_outcome';
    const key = cleanText(`${proposalId}|${evidenceRef}`, 260);
    if (captured.has(key)) continue;
    planned.push({ proposal_id: proposalId, evidence_ref: evidenceRef, key });
  }
  if (apply) {
    for (const item of planned) {
      let ok = false;
      let reason = 'artifact_bridge_skipped';
      if (Array.isArray(cfg.command) && cfg.command.length > 0) {
        const cmd = cfg.command.slice();
        const proc = spawnSync(cmd[0], cmd.slice(1).concat([
          `--proposal-id=${item.proposal_id}`,
          `--evidence-ref=${item.evidence_ref}`,
          `--date=${date}`
        ]), {
          cwd: ROOT,
          encoding: 'utf8'
        });
        ok = Number(proc.status || 0) === 0;
        reason = ok ? 'artifact_bridge_command_ok' : 'artifact_bridge_command_failed';
      } else if (cfg.mode === 'dopamine_log_artifact') {
        const ref = `proposal_outcome:${item.proposal_id}:${sha256Object(item.evidence_ref).slice(0, 10)}`;
        const proc = spawnSync(process.execPath, [
          path.join(ROOT, 'habits', 'scripts', 'dopamine_engine.js'),
          'log_artifact',
          'note',
          ref,
          cleanText(cfg.directive, 120) || 'queue_outcome_shipped_v1'
        ], {
          cwd: ROOT,
          encoding: 'utf8'
        });
        ok = Number(proc.status || 0) === 0;
        reason = ok ? 'dopamine_log_artifact_ok' : 'dopamine_log_artifact_failed';
      }
      bridged.push({
        proposal_id: item.proposal_id,
        evidence_ref: item.evidence_ref,
        ok,
        reason
      });
      if (ok) captured.add(item.key);
    }
    writeJsonAtomic(policy.paths.artifact_state_path, {
      schema_id: 'execution_yield_recovery_artifact_state',
      schema_version: '1.0',
      ts: nowIso(),
      captured_keys: Array.from(captured).slice(-5000)
    });
  }
  return {
    enabled: true,
    planned_count: planned.length,
    planned: planned.slice(0, 50),
    bridged_count: bridged.filter((row) => row.ok === true).length,
    bridged: bridged.slice(0, 50),
    state_path: relPath(policy.paths.artifact_state_path)
  };
}

function publishControlPlaneEvent(policy: AnyObj, payload: AnyObj, apply: boolean) {
  const cfg = policy.event_stream || {};
  if (cfg.enabled !== true || !apply) return { published: false, reason: 'event_stream_disabled_or_preview' };
  const scriptPath = cfg.script_path;
  if (!fs.existsSync(scriptPath)) return { published: false, reason: 'event_stream_script_missing', script_path: relPath(scriptPath) };
  const body = {
    schema_id: 'execution_yield_recovery_event',
    schema_version: '1.0',
    ts: nowIso(),
    summary: {
      date: payload.date,
      funnel: payload.funnel,
      dead_window_alert: payload.dead_window_alert,
      top_k_applied: Number(payload.top_k && payload.top_k.applied ? payload.top_k.applied.length : 0),
      escalation_salvage_count: Number(payload.adaptive_escalation_ttl && payload.adaptive_escalation_ttl.salvage_count || 0),
      execution_floor_miss: !!(payload.execution_floor && payload.execution_floor.miss_floor)
    }
  };
  const proc = spawnSync(process.execPath, [
    scriptPath,
    'append',
    `--stream=${cfg.stream || 'ops'}`,
    `--event=${cfg.event || 'yield_recovery_tick'}`,
    `--payload_json=${JSON.stringify(body)}`
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    published: Number(proc.status || 0) === 0,
    status: Number(proc.status || 0),
    script_path: relPath(scriptPath),
    reason: Number(proc.status || 0) === 0 ? 'event_stream_append_ok' : 'event_stream_append_failed'
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/execution_yield_recovery.js run [YYYY-MM-DD] [--apply=1|0] [--strict=1|0] [--policy=path]');
  console.log('  node systems/ops/execution_yield_recovery.js status [--policy=path]');
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'execution_yield_recovery',
      error: 'policy_disabled',
      policy_path: relPath(policy.policy_path)
    }, null, 2)}\n`);
    process.exit(1);
  }

  const date = normalizeDate(args._[1] || args.date);
  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, false);
  const windowDays = clampInt(args.days, 1, 365, policy.window_days);
  const deadWindowDays = clampInt(args['dead-window-days'], 1, 365, policy.dead_window_days);
  const windowDates = dateWindow(date, windowDays);
  const deadDates = dateWindow(date, deadWindowDays);
  const queueEvents = loadQueueEvents(policy.paths.queue_log_path);
  const decisionEventsWindow = readDecisionEvents(policy.paths.decisions_dir, windowDates);
  const decisionEventsDead = readDecisionEvents(policy.paths.decisions_dir, deadDates);
  const decisionEventsToday = readDecisionEvents(policy.paths.decisions_dir, [date]);
  const proposalCatalog = loadProposalsCatalog(policy.paths.proposals_dir, windowDates);
  const queueState = buildQueueState(queueEvents);
  const nowMs = Date.parse(`${date}T23:59:59.999Z`);
  const openRowsBefore = openQueueRows(queueState, proposalCatalog.byId, nowMs);
  const startMs = Date.parse(`${windowDates[windowDates.length - 1]}T00:00:00.000Z`);
  const endMs = nowMs;
  const funnel = computeFunnel(queueEvents, decisionEventsWindow, startMs, endMs);
  const deadStartMs = Date.parse(`${deadDates[deadDates.length - 1]}T00:00:00.000Z`);
  const deadWindow = detectDeadWindow(decisionEventsDead, deadStartMs, endMs);

  const filterRecovery = recoverFilteredHighScore(
    policy,
    policy.paths.queue_log_path,
    policy.paths.decisions_dir,
    date,
    queueEvents,
    queueState,
    proposalCatalog,
    apply
  );

  const queueEventsAfterRecovery = apply ? loadQueueEvents(policy.paths.queue_log_path) : queueEvents;
  const queueStateAfterRecovery = buildQueueState(queueEventsAfterRecovery);
  const openRowsAfterRecovery = openQueueRows(queueStateAfterRecovery, proposalCatalog.byId, nowMs);

  const adaptiveEscalation = handleAdaptiveEscalationTtl(
    policy,
    date,
    policy.paths.queue_log_path,
    policy.paths.decisions_dir,
    openRowsAfterRecovery,
    apply
  );

  const queueEventsAfterEscalation = apply ? loadQueueEvents(policy.paths.queue_log_path) : queueEventsAfterRecovery;
  const queueStateAfterEscalation = buildQueueState(queueEventsAfterEscalation);
  const openRowsAfterEscalation = openQueueRows(queueStateAfterEscalation, proposalCatalog.byId, nowMs);

  const reserved = new Set<string>();
  const topK = reserveTopK(
    policy,
    date,
    policy.paths.queue_log_path,
    policy.paths.decisions_dir,
    openRowsAfterEscalation,
    apply,
    reserved
  );

  const queueEventsAfterTopK = apply ? loadQueueEvents(policy.paths.queue_log_path) : queueEventsAfterEscalation;
  const queueStateAfterTopK = buildQueueState(queueEventsAfterTopK);
  const openRowsAfterTopK = openQueueRows(queueStateAfterTopK, proposalCatalog.byId, nowMs);
  const backpressure = resolveThrottleState(policy, openRowsAfterTopK, apply);
  const eyeHealth = classifyEyeHealth(policy, apply);
  const executionFloor = evaluateExecutionFloor(
    policy,
    date,
    decisionEventsToday,
    openRowsAfterTopK,
    apply,
    policy.paths.queue_log_path,
    policy.paths.decisions_dir,
    reserved
  );
  const artifactBridge = runArtifactBridge(policy, date, decisionEventsToday, apply);

  const output = {
    ok: true,
    type: 'execution_yield_recovery',
    ts: nowIso(),
    date,
    strict,
    apply,
    policy_path: relPath(policy.policy_path),
    window_days: windowDays,
    dead_window_days: deadWindowDays,
    funnel,
    dead_window_alert: deadWindow.dead_window === true,
    dead_window_shipped: deadWindow.shipped,
    queue: {
      open_before: openRowsBefore.length,
      open_after: openRowsAfterTopK.length
    },
    filter_rebalance: filterRecovery,
    adaptive_escalation_ttl: adaptiveEscalation,
    top_k: topK,
    queue_backpressure: backpressure,
    eye_health: eyeHealth,
    execution_floor: executionFloor,
    artifact_bridge: artifactBridge,
    ticket_status: {
      'V3-RACE-069': 'implemented',
      'V3-RACE-070': 'implemented',
      'V3-RACE-071': 'implemented',
      'V3-RACE-072': 'implemented',
      'V3-RACE-073': 'implemented',
      'V3-RACE-074': 'implemented',
      'V3-RACE-075': 'implemented',
      'V3-RACE-076': 'implemented',
      'V3-RACE-077': 'implemented'
    },
    paths: {
      queue_log_path: relPath(policy.paths.queue_log_path),
      proposals_dir: relPath(policy.paths.proposals_dir),
      decisions_dir: relPath(policy.paths.decisions_dir),
      latest_path: relPath(policy.paths.latest_path),
      history_path: relPath(policy.paths.history_path)
    }
  };

  const streamEvent = publishControlPlaneEvent(policy, output, apply);
  output.event_stream = streamEvent;

  writeJsonAtomic(policy.paths.latest_path, output);
  appendJsonl(policy.paths.history_path, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  const shouldFailStrict = strict && (
    output.dead_window_alert === true
    || (output.execution_floor && output.execution_floor.miss_floor === true)
  );
  if (shouldFailStrict) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.paths.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'execution_yield_recovery_status',
      error: 'latest_missing',
      latest_path: relPath(policy.paths.latest_path),
      policy_path: relPath(policy.policy_path)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'execution_yield_recovery_status',
    ts: nowIso(),
    policy_path: relPath(policy.policy_path),
    latest_path: relPath(policy.paths.latest_path),
    payload: latest
  }, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 60);
  if (!cmd || cmd === 'help' || cmd === 'h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status' || cmd === 'latest') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  computeFunnel,
  detectDeadWindow,
  inferExecutionScore
};

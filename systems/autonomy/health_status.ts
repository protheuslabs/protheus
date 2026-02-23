#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getStopState } = require('../../lib/emergency_stop.js');
const { resolveCatalogPath } = require('../../lib/eyes_catalog.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

const AUTONOMY_CONTROLLER = process.env.AUTONOMY_HEALTH_AUTONOMY_CONTROLLER_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_AUTONOMY_CONTROLLER_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const RECEIPT_SUMMARY = process.env.AUTONOMY_HEALTH_RECEIPT_SUMMARY_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_RECEIPT_SUMMARY_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'receipt_summary.js');
const STRATEGY_DOCTOR = process.env.AUTONOMY_HEALTH_STRATEGY_DOCTOR_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_STRATEGY_DOCTOR_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'strategy_doctor.js');
const STRATEGY_READINESS = process.env.AUTONOMY_HEALTH_STRATEGY_READINESS_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_STRATEGY_READINESS_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'strategy_readiness.js');
const STRATEGY_MODE_GOVERNOR = process.env.AUTONOMY_HEALTH_STRATEGY_MODE_GOVERNOR_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_STRATEGY_MODE_GOVERNOR_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'strategy_mode_governor.js');
const ARCHITECTURE_GUARD = process.env.AUTONOMY_HEALTH_ARCH_GUARD_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_ARCH_GUARD_SCRIPT)
  : path.join(ROOT, 'systems', 'security', 'architecture_guard.js');
const MODEL_ROUTER = process.env.AUTONOMY_HEALTH_MODEL_ROUTER_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_MODEL_ROUTER_SCRIPT)
  : path.join(ROOT, 'systems', 'routing', 'model_router.js');
const PIPELINE_SPC_GATE = process.env.AUTONOMY_HEALTH_PIPELINE_SPC_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_PIPELINE_SPC_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'pipeline_spc_gate.js');
const INTEGRITY_KERNEL = process.env.AUTONOMY_HEALTH_INTEGRITY_KERNEL_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_INTEGRITY_KERNEL_SCRIPT)
  : path.join(ROOT, 'systems', 'security', 'integrity_kernel.js');
const STARTUP_ATTESTATION = process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_SCRIPT
  ? path.resolve(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_SCRIPT)
  : path.join(ROOT, 'systems', 'security', 'startup_attestation.js');
const INTEGRITY_POLICY = process.env.AUTONOMY_HEALTH_INTEGRITY_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_INTEGRITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'security_integrity_policy.json');

const ACTUATION_RECEIPTS_DIR = process.env.AUTONOMY_HEALTH_ACTUATION_RECEIPTS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_ACTUATION_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'actuation', 'receipts');
const SPINE_HEALTH_PATH = process.env.AUTONOMY_HEALTH_SPINE_HEALTH_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_SPINE_HEALTH_PATH)
  : path.join(ROOT, 'state', 'spine', 'router_health.json');
const ROUTING_MODEL_HEALTH_PATH = process.env.AUTONOMY_HEALTH_ROUTING_MODEL_HEALTH_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_ROUTING_MODEL_HEALTH_PATH)
  : path.join(ROOT, 'state', 'routing', 'model_health.json');
const ROUTING_DECISIONS_LOG_PATH = process.env.AUTONOMY_HEALTH_ROUTING_DECISIONS_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_ROUTING_DECISIONS_PATH)
  : path.join(ROOT, 'state', 'routing', 'routing_decisions.jsonl');
const AUTONOMY_COOLDOWNS = process.env.AUTONOMY_HEALTH_COOLDOWNS_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_COOLDOWNS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'cooldowns.json');
const EYES_REGISTRY_PATH = process.env.AUTONOMY_HEALTH_EYES_REGISTRY_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_EYES_REGISTRY_PATH)
  : path.join(ROOT, 'state', 'sensory', 'eyes', 'registry.json');
const EYES_CATALOG_PATH = resolveCatalogPath(ROOT);
const PROPOSALS_DIR = process.env.AUTONOMY_HEALTH_PROPOSALS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');
const QUEUE_DECISIONS_DIR = process.env.AUTONOMY_HEALTH_QUEUE_DECISIONS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_QUEUE_DECISIONS_DIR)
  : path.join(ROOT, 'state', 'queue', 'decisions');
const AUTONOMY_RUNS_DIR = process.env.AUTONOMY_HEALTH_AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_AUTONOMY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const ALERTS_DIR = process.env.AUTONOMY_HEALTH_ALERTS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_ALERTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'health_alerts');
const REPORTS_DIR = process.env.AUTONOMY_HEALTH_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_HEALTH_REPORTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'health_reports');
const SYSTEM_BUDGET_EVENTS_PATH = process.env.AUTONOMY_HEALTH_SYSTEM_BUDGET_EVENTS_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_SYSTEM_BUDGET_EVENTS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'budget_events.jsonl');
const SYSTEM_BUDGET_AUTOPAUSE_PATH = process.env.AUTONOMY_HEALTH_SYSTEM_BUDGET_AUTOPAUSE_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_SYSTEM_BUDGET_AUTOPAUSE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
const STARTUP_ATTESTATION_AUDIT_PATH = process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_AUDIT_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_AUDIT_PATH)
  : path.join(ROOT, 'state', 'security', 'startup_attestation_audit.jsonl');
const DREAM_IDLE_RUNS_PATH = process.env.AUTONOMY_HEALTH_DREAM_IDLE_RUNS_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_DREAM_IDLE_RUNS_PATH)
  : path.join(ROOT, 'state', 'memory', 'dreams', 'idle_runs.jsonl');

const NOW_ISO_OVERRIDE = String(process.env.AUTONOMY_HEALTH_NOW_ISO || '').trim();
const SKIP_COMMANDS = String(process.env.AUTONOMY_HEALTH_SKIP_COMMANDS || '0') === '1';

const DARK_EYE_MAX_IDLE_HOURS = Number(process.env.AUTONOMY_HEALTH_DARK_EYE_MAX_IDLE_HOURS || 12);
const DARK_EYE_FAIL_COUNT = Number(process.env.AUTONOMY_HEALTH_DARK_EYE_FAIL_COUNT || 2);
const DARK_EYE_CRITICAL_RATIO = Number(process.env.AUTONOMY_HEALTH_DARK_EYE_CRITICAL_RATIO || 0.4);
const DARK_EYE_CRITICAL_MIN = Number(process.env.AUTONOMY_HEALTH_DARK_EYE_CRITICAL_MIN || 2);

const STARVATION_MIN_ELIGIBLE = Number(process.env.AUTONOMY_HEALTH_STARVATION_MIN_ELIGIBLE || 3);
const STARVATION_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_STARVATION_WARN_HOURS || 18);
const STARVATION_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_STARVATION_CRITICAL_HOURS || 36);
const STARVATION_CRITICAL_ELIGIBLE = Number(process.env.AUTONOMY_HEALTH_STARVATION_CRITICAL_ELIGIBLE || 6);
const STARVATION_PREVIEW_WARN_ELIGIBLE = Number(process.env.AUTONOMY_HEALTH_STARVATION_PREVIEW_WARN_ELIGIBLE || STARVATION_MIN_ELIGIBLE);
const STARVATION_PREVIEW_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_STARVATION_PREVIEW_WARN_HOURS || STARVATION_WARN_HOURS);
const STARVATION_MIN_DAILY_EXECUTIONS = Number(
  process.env.AUTONOMY_HEALTH_STARVATION_MIN_DAILY_EXECUTIONS
  || process.env.AUTONOMY_MIN_DAILY_EXECUTIONS
  || 1
);
const STARVATION_QUOTA_GRACE_HOURS = Number(process.env.AUTONOMY_HEALTH_STARVATION_QUOTA_GRACE_HOURS || 8);
const QUEUE_BACKLOG_WARN_OPEN = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_WARN_OPEN || 40);
const QUEUE_BACKLOG_CRITICAL_OPEN = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_CRITICAL_OPEN || 80);
const QUEUE_BACKLOG_DIVERGENCE_WARN = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_DIVERGENCE_WARN || 12);
const QUEUE_BACKLOG_DIVERGENCE_CRITICAL = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_DIVERGENCE_CRITICAL || 30);
const QUEUE_BACKLOG_WARN_AGE_HOURS = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_WARN_AGE_HOURS || 24);
const QUEUE_BACKLOG_CRITICAL_AGE_HOURS = Number(process.env.AUTONOMY_HEALTH_QUEUE_BACKLOG_CRITICAL_AGE_HOURS || 72);

const LOOP_STALL_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_LOOP_STALL_WARN_HOURS || 8);
const LOOP_STALL_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_LOOP_STALL_CRITICAL_HOURS || 24);

const ROUTING_DOWN_WARN = Number(process.env.AUTONOMY_HEALTH_ROUTING_DOWN_WARN || 1);
const ROUTING_DOWN_CRITICAL = Number(process.env.AUTONOMY_HEALTH_ROUTING_DOWN_CRITICAL || 3);
const DREAM_DEGRADE_WARN_RATIO = Number(process.env.AUTONOMY_HEALTH_DREAM_DEGRADE_WARN_RATIO || 0.35);
const DREAM_DEGRADE_CRITICAL_RATIO = Number(process.env.AUTONOMY_HEALTH_DREAM_DEGRADE_CRITICAL_RATIO || 0.75);
const DREAM_FALLBACK_WARN_COUNT = Number(process.env.AUTONOMY_HEALTH_DREAM_FALLBACK_WARN_COUNT || 2);
const DREAM_PREFLIGHT_FAIL_WARN_COUNT = Number(process.env.AUTONOMY_HEALTH_DREAM_PREFLIGHT_FAIL_WARN_COUNT || 3);
const DREAM_MISSING_RUN_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_DREAM_MISSING_RUN_WARN_HOURS || 12);
const DREAM_MISSING_RUN_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_DREAM_MISSING_RUN_CRITICAL_HOURS || 24);
const BUDGET_DEGRADE_WARN_COUNT = Number(process.env.AUTONOMY_HEALTH_BUDGET_DEGRADE_WARN_COUNT || 3);
const ROUTE_ATTESTATION_WARN = Number(process.env.AUTONOMY_HEALTH_ROUTE_ATTESTATION_WARN || 1);
const ROUTE_ATTESTATION_CRITICAL = Number(process.env.AUTONOMY_HEALTH_ROUTE_ATTESTATION_CRITICAL || 3);
const ROUTING_RECOVERY_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_ROUTING_RECOVERY_WARN_HOURS || 24);
const ROUTING_RECOVERY_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_ROUTING_RECOVERY_CRITICAL_HOURS || 72);
const STARTUP_ATTESTATION_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_WARN_HOURS || 12);
const STARTUP_ATTESTATION_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_CRITICAL_HOURS || 36);
const STARTUP_ATTESTATION_AUTO_ISSUE = String(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_AUTO_ISSUE || '1') !== '0';
const STARTUP_ATTESTATION_AUTO_ISSUE_REASONS = new Set(
  String(process.env.AUTONOMY_HEALTH_STARTUP_ATTESTATION_AUTO_ISSUE_REASONS || 'attestation_missing_or_invalid,attestation_stale,critical_hash_drift')
    .split(',')
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)
);
const EXECUTE_LOCK_AUTO_DEMOTE = String(process.env.AUTONOMY_HEALTH_EXECUTE_LOCK_AUTO_DEMOTE || '1') !== '0';

const SPC_BASELINE_DAYS = Number(process.env.AUTONOMY_HEALTH_SPC_BASELINE_DAYS || 21);
const SPC_SIGMA = Number(process.env.AUTONOMY_HEALTH_SPC_SIGMA || 3);
const SPC_STOP_RATIO_MIN_DENOM = Number(process.env.AUTONOMY_HEALTH_SPC_STOP_RATIO_MIN_DENOM || 4);

function nowMs() {
  if (NOW_ISO_OVERRIDE) {
    const n = Date.parse(NOW_ISO_OVERRIDE);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function nowIso() {
  return new Date(nowMs()).toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/health_status.js [YYYY-MM-DD] [--window=daily|weekly] [--days=N] [--alerts=1|0] [--write=1|0] [--strict]');
  console.log('  node systems/autonomy/health_status.js --help');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function resolveDateArg(args) {
  const first = String(args._[0] || '').trim();
  if (isDateStr(first)) return first;
  if ((first === 'run' || first === 'status') && isDateStr(args._[1])) return String(args._[1]);
  return todayStr();
}

function resolveWindow(args) {
  const rawWindow = String(args.window || '').trim().toLowerCase();
  if (rawWindow === 'weekly') {
    const days = toInt(args.days, 7, 2, 30);
    return { label: 'weekly', days };
  }
  if (rawWindow === 'daily') {
    const days = toInt(args.days, 1, 1, 7);
    return { label: 'daily', days };
  }
  const days = toInt(args.days, 1, 1, 30);
  if (days >= 7) return { label: 'weekly', days };
  return { label: 'daily', days };
}

function runJson(script, args) {
  if (SKIP_COMMANDS) {
    return { ok: true, code: 0, payload: { ok: true, skipped: true }, stderr: '' };
  }
  const r = spawnSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    try {
      payload = JSON.parse(out);
    } catch {
      const line = out.split('\n').find((x) => x.trim().startsWith('{'));
      if (line) {
        try { payload = JSON.parse(line); } catch {}
      }
    }
  }
  return { ok: r.status === 0, code: r.status || 0, payload, stderr: String(r.stderr || '').trim() };
}

function normalizeReasonToken(v) {
  return String(v || '').trim().toLowerCase();
}

function verifyStartupAttestationWithAutoIssue() {
  let verify = runJson(STARTUP_ATTESTATION, ['verify']);
  let verifyPayload = verify && verify.payload && typeof verify.payload === 'object' ? verify.payload : null;
  const beforeReason = normalizeReasonToken(verifyPayload && verifyPayload.reason);
  const out = {
    attempted: false,
    issue_ok: null as null | boolean,
    verify_ok_before: verify.ok && !!verifyPayload && verifyPayload.ok === true,
    verify_ok_after: null as null | boolean,
    reason_before: beforeReason || null,
    reason_after: null as null | string
  };
  if (!STARTUP_ATTESTATION_AUTO_ISSUE) {
    out.reason_after = out.reason_before;
    out.verify_ok_after = out.verify_ok_before;
    return { verify, auto_issue: out };
  }
  if (out.verify_ok_before || !STARTUP_ATTESTATION_AUTO_ISSUE_REASONS.has(beforeReason)) {
    out.reason_after = out.reason_before;
    out.verify_ok_after = out.verify_ok_before;
    return { verify, auto_issue: out };
  }
  out.attempted = true;
  const issue = runJson(STARTUP_ATTESTATION, ['issue']);
  const issuePayload = issue && issue.payload && typeof issue.payload === 'object' ? issue.payload : null;
  out.issue_ok = issue.ok && !!issuePayload && issuePayload.ok === true;
  if (out.issue_ok) {
    verify = runJson(STARTUP_ATTESTATION, ['verify']);
    verifyPayload = verify && verify.payload && typeof verify.payload === 'object' ? verify.payload : null;
  }
  const afterReason = normalizeReasonToken(verifyPayload && verifyPayload.reason);
  out.reason_after = afterReason || null;
  out.verify_ok_after = verify.ok && !!verifyPayload && verifyPayload.ok === true;
  return { verify, auto_issue: out };
}

function shouldAutoDemoteExecuteFromGovernor(statusResult) {
  if (!(statusResult && statusResult.ok)) return false;
  const payload = statusResult.payload && typeof statusResult.payload === 'object'
    ? statusResult.payload
    : {};
  const strategy = payload && payload.strategy && typeof payload.strategy === 'object'
    ? payload.strategy
    : {};
  const canary = payload && payload.canary && typeof payload.canary === 'object'
    ? payload.canary
    : {};
  const metrics = canary && canary.metrics && typeof canary.metrics === 'object'
    ? canary.metrics
    : {};
  const policy = payload && payload.policy && typeof payload.policy === 'object'
    ? payload.policy
    : {};
  const transition = payload && payload.transition && typeof payload.transition === 'object'
    ? payload.transition
    : {};
  const mode = String(strategy.mode || '');
  const requireLock = metrics.require_quality_lock_for_execute === true
    || policy.canary_require_quality_lock_for_execute === true;
  const qualityLockActive = metrics.quality_lock_active === true;
  const transitionTo = String(transition.to_mode || '');
  const transitionReason = String(transition.reason || '');
  return mode === 'execute'
    && requireLock
    && !qualityLockActive
    && transitionTo === 'canary_execute'
    && transitionReason === 'quality_lock_inactive_demote_canary';
}

function runStrategyGovernorWithAutoDemotion(dateStr: string, days: number) {
  const boundedDays = Math.max(1, Number(days || 1));
  const statusArgs = ['status', dateStr, `--days=${boundedDays}`];
  let status = runJson(STRATEGY_MODE_GOVERNOR, statusArgs);
  const out = {
    attempted: false,
    run_ok: null as null | boolean,
    run_result: null as null | string,
    from_mode: null as null | string,
    to_mode: null as null | string,
    reason: null as null | string
  };
  if (!EXECUTE_LOCK_AUTO_DEMOTE || !shouldAutoDemoteExecuteFromGovernor(status)) {
    return { status, auto_demotion: out };
  }
  out.attempted = true;
  const run = runJson(STRATEGY_MODE_GOVERNOR, ['run', dateStr, `--days=${boundedDays}`]);
  const runPayload = run && run.payload && typeof run.payload === 'object'
    ? run.payload
    : null;
  out.run_ok = run.ok && !!runPayload && runPayload.ok === true;
  out.run_result = runPayload && runPayload.result ? String(runPayload.result) : null;
  out.from_mode = runPayload && runPayload.from_mode ? String(runPayload.from_mode) : null;
  out.to_mode = runPayload && runPayload.to_mode ? String(runPayload.to_mode) : null;
  out.reason = runPayload && runPayload.reason ? String(runPayload.reason) : null;
  status = runJson(STRATEGY_MODE_GOVERNOR, statusArgs);
  return { status, auto_demotion: out };
}

function parseJsonWithRecovery(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { ok: false, value: null, recovered: false };
  try {
    return { ok: true, value: JSON.parse(text), recovered: false };
  } catch {}
  const starts = [];
  const objStart = text.indexOf('{');
  if (objStart >= 0) starts.push({ start: objStart, close: '}' });
  const arrStart = text.indexOf('[');
  if (arrStart >= 0) starts.push({ start: arrStart, close: ']' });
  starts.sort((a, b) => a.start - b.start);
  for (const cand of starts) {
    for (let idx = text.length - 1; idx > cand.start; idx -= 1) {
      if (text[idx] !== cand.close) continue;
      try {
        return {
          ok: true,
          value: JSON.parse(text.slice(cand.start, idx + 1)),
          recovered: true
        };
      } catch {}
    }
  }
  return { ok: false, value: null, recovered: false };
}

function readJson(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    const parsed = parseJsonWithRecovery(fs.readFileSync(fp, 'utf8'));
    return parsed.ok ? parsed.value : fallback;
  } catch {
    return fallback;
  }
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function dateShift(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dateShift(endDate, -i));
  return out;
}

function toMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : null;
}

function hoursSince(ts, now) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Number(((Number(now) - t) / 3600000).toFixed(3));
}

function buildEyeRuntimeMeta(catalog, registry) {
  const map = new Map();
  const catalogEyes = Array.isArray(catalog && catalog.eyes) ? catalog.eyes : [];
  const registryEyes = Array.isArray(registry && registry.eyes) ? registry.eyes : [];
  for (const eye of catalogEyes) {
    const id = String(eye && eye.id || '').trim();
    if (!id) continue;
    map.set(id, { ...eye });
  }
  for (const eye of registryEyes) {
    const id = String(eye && eye.id || '').trim();
    if (!id) continue;
    map.set(id, { ...(map.get(id) || {}), ...eye });
  }
  return map;
}

function lastTs(rows, predicate) {
  let best = null;
  for (const row of rows || []) {
    if (predicate && predicate(row) !== true) continue;
    const t = toMs(row && row.ts);
    if (!Number.isFinite(t)) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}

function readProposalRows(dates) {
  const rows = [];
  for (const d of dates) {
    const fp = path.join(PROPOSALS_DIR, `${d}.json`);
    if (!fs.existsSync(fp)) continue;
    const raw = readJson(fp, []);
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
    for (const p of list) rows.push({ date: d, proposal: p });
  }
  return rows;
}

function readQueueEvents(dates) {
  const rows = [];
  for (const d of dates) {
    const fp = path.join(QUEUE_DECISIONS_DIR, `${d}.jsonl`);
    rows.push(...readJsonl(fp));
  }
  return rows;
}

function readAutonomyRunEvents(dates) {
  const rows = [];
  for (const d of dates) {
    const fp = path.join(AUTONOMY_RUNS_DIR, `${d}.jsonl`);
    for (const row of readJsonl(fp)) {
      if (row && row.type === 'autonomy_run') rows.push(row);
    }
  }
  return rows;
}

function readIdleDreamEvents(dates) {
  const allowedDates = new Set(Array.isArray(dates) ? dates.map((d) => String(d || '')) : []);
  const rows = readJsonl(DREAM_IDLE_RUNS_PATH);
  return rows.filter((row) => {
    const evt = row && typeof row === 'object' ? row : {};
    const day = String(evt.date || '').trim() || String(evt.ts || '').slice(0, 10);
    if (!day) return false;
    return allowedDates.size > 0 ? allowedDates.has(day) : true;
  });
}

function isAttemptedReceipt(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const contract = rec.receipt_contract;
  if (!contract || typeof contract !== 'object') return true;
  return contract.attempted !== false;
}

function actuationReceiptSummary(dateStr) {
  const fp = path.join(ACTUATION_RECEIPTS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  const attemptedRows = rows.filter(isAttemptedReceipt);
  const out = {
    total: attemptedRows.length,
    skipped_not_attempted: rows.length - attemptedRows.length,
    ok: 0,
    failed: 0,
    verified: 0,
    by_adapter: {}
  };
  for (const r of attemptedRows) {
    const adapter = String(r.adapter || 'unknown');
    out.by_adapter[adapter] = out.by_adapter[adapter] || { total: 0, ok: 0, verified: 0 };
    out.by_adapter[adapter].total += 1;
    if (r.ok === true) {
      out.ok += 1;
      out.by_adapter[adapter].ok += 1;
    } else {
      out.failed += 1;
    }
    const verified = !!(r.receipt_contract && r.receipt_contract.verified === true);
    if (verified) {
      out.verified += 1;
      out.by_adapter[adapter].verified += 1;
    }
  }
  return out;
}

function routingHealthCacheSummary() {
  const snap = readJson(ROUTING_MODEL_HEALTH_PATH, null);
  if (!snap || typeof snap !== 'object') {
    return {
      path: ROUTING_MODEL_HEALTH_PATH,
      schema_version: null,
      active_runtime: null,
      runtimes: [],
      by_runtime_counts: {},
      records_count: 0
    };
  }
  const schemaVersion = Number(snap.schema_version || 0) || null;
  const runtimes = [];
  const byRuntimeCounts: AnyObj = {};
  if (snap.runtimes && typeof snap.runtimes === 'object') {
    for (const [runtime, map] of Object.entries(snap.runtimes)) {
      if (!map || typeof map !== 'object') continue;
      runtimes.push(String(runtime));
      byRuntimeCounts[String(runtime)] = Object.keys(map).length;
    }
  }
  let recordsCount = 0;
  if (snap.records && typeof snap.records === 'object') {
    recordsCount = Object.keys(snap.records).length;
  } else if (!schemaVersion) {
    const legacyKeys = Object.keys(snap).filter((k) => {
      const v = snap[k];
      return !!(v && typeof v === 'object' && typeof v.model === 'string');
    });
    recordsCount = legacyKeys.length;
    if (!runtimes.length && legacyKeys.length) {
      runtimes.push('legacy');
      byRuntimeCounts.legacy = legacyKeys.length;
    }
  }
  return {
    path: ROUTING_MODEL_HEALTH_PATH,
    schema_version: schemaVersion,
    active_runtime: typeof snap.active_runtime === 'string' ? snap.active_runtime : null,
    runtimes,
    by_runtime_counts: byRuntimeCounts,
    records_count: recordsCount
  };
}

function routingDoctorRuntimeSummary(payload) {
  const rows = payload && Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  if (!rows.length) {
    return {
      total_local_models: 0,
      local_eligible_models: 0,
      source_runtime_counts: {},
      stale_local_records: 0,
      local_best_source_runtime: null
    };
  }
  const localRows = rows.filter((r) => r && r.local === true);
  const sourceRuntimeCounts = {};
  let staleLocalRecords = 0;
  let localEligible = 0;
  for (const row of localRows) {
    const runtime = String((row.local_health && row.local_health.source_runtime) || 'unknown');
    sourceRuntimeCounts[runtime] = Number(sourceRuntimeCounts[runtime] || 0) + 1;
    if (row.local_health && row.local_health.stale === true) staleLocalRecords += 1;
    if (row.eligible === true) localEligible += 1;
  }
  const localBest = payload && payload.tier1_local_decision && payload.tier1_local_decision.local_best
    ? String(payload.tier1_local_decision.local_best)
    : '';
  const bestRow = localRows.find((r) => String(r.model || '') === localBest);
  return {
    total_local_models: localRows.length,
    local_eligible_models: localEligible,
    source_runtime_counts: sourceRuntimeCounts,
    stale_local_records: staleLocalRecords,
    local_best_source_runtime: bestRow && bestRow.local_health
      ? String(bestRow.local_health.source_runtime || 'unknown')
      : null
  };
}

function topReasonCounts(mapObj, limit = 5) {
  const entries = Object.entries(mapObj || {})
    .map(([reason, count]) => ({ reason: String(reason || ''), count: Number(count || 0) }))
    .filter((row) => row.reason && row.count > 0)
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
  return entries.slice(0, Math.max(1, Number(limit || 5)));
}

function routingRecoveryPulseSummary(dateSet, now) {
  const rows = readJsonl(ROUTING_DECISIONS_LOG_PATH)
    .filter((row) => row && typeof row === 'object')
    .filter((row) => String(row.type || '') === 'local_health_warmup_pulse');
  const datesAllowed = new Set(Array.isArray(dateSet) ? dateSet.map((d) => String(d || '')) : []);
  const scoped = rows.filter((row) => {
    const ts = String(row.ts || '');
    const day = ts.slice(0, 10);
    return datesAllowed.size > 0 ? datesAllowed.has(day) : true;
  });
  const reasonCounts = {};
  let warmedTotal = 0;
  let recoveredTotal = 0;
  let skippedInterval = 0;
  const recoveredModels = new Set();
  let lastTs = null;
  for (const row of scoped) {
    const reason = String(row.reason || row.skipped_reason || 'unknown');
    reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
    warmedTotal += Number(row.warmed_count || 0);
    recoveredTotal += Number(row.recovered_count || 0);
    if (String(row.skipped_reason || '') === 'interval_not_elapsed') skippedInterval += 1;
    const models = Array.isArray(row.recovered_models) ? row.recovered_models : [];
    for (const model of models) {
      const id = String(model || '').trim();
      if (id) recoveredModels.add(id);
    }
    const tsMs = toMs(row.ts);
    if (Number.isFinite(tsMs) && (!lastTs || tsMs > lastTs)) lastTs = tsMs;
  }
  return {
    path: ROUTING_DECISIONS_LOG_PATH,
    pulse_events: scoped.length,
    warmed_total: warmedTotal,
    recovered_total: recoveredTotal,
    recovered_models: Array.from(recoveredModels).sort(),
    skipped_interval_count: skippedInterval,
    top_reasons: topReasonCounts(reasonCounts, 6),
    last_pulse_ts: lastTs ? new Date(lastTs).toISOString() : null,
    last_pulse_age_hours: lastTs ? hoursSince(lastTs, now) : null
  };
}

function startupAttestationTelemetrySummary(dateSet, now) {
  const rows = readJsonl(STARTUP_ATTESTATION_AUDIT_PATH)
    .filter((row) => row && typeof row === 'object')
    .filter((row) => String(row.type || '') === 'startup_attestation_verify');
  const datesAllowed = new Set(Array.isArray(dateSet) ? dateSet.map((d) => String(d || '')) : []);
  const scoped = rows.filter((row) => {
    const ts = String(row.ts || '');
    const day = ts.slice(0, 10);
    return datesAllowed.size > 0 ? datesAllowed.has(day) : true;
  });
  let okCount = 0;
  let failCount = 0;
  let lastTs = null;
  const reasonCounts = {};
  for (const row of scoped) {
    const ok = row.ok === true;
    if (ok) okCount += 1;
    else failCount += 1;
    const reason = String(row.reason || '').trim() || 'unknown';
    reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
    const tsMs = toMs(row.ts);
    if (Number.isFinite(tsMs) && (!lastTs || tsMs > lastTs)) lastTs = tsMs;
  }
  return {
    path: STARTUP_ATTESTATION_AUDIT_PATH,
    verify_events: scoped.length,
    verify_ok_count: okCount,
    verify_fail_count: failCount,
    last_verify_ts: lastTs ? new Date(lastTs).toISOString() : null,
    last_verify_age_hours: lastTs ? hoursSince(lastTs, now) : null,
    top_reasons: topReasonCounts(reasonCounts, 6)
  };
}

function levelRank(level) {
  if (level === 'critical') return 3;
  if (level === 'warn') return 2;
  if (level === 'unknown') return 1;
  return 0;
}

function assessDarkEyes(now, registry, eyeMetaMap = null) {
  const eyes = registry && Array.isArray(registry.eyes) ? registry.eyes : [];
  const metaMap = eyeMetaMap instanceof Map ? eyeMetaMap : new Map();
  const dark = [];
  let monitoredTotal = 0;
  for (const eye of eyes) {
    const id = String(eye && eye.id || '');
    if (!id) continue;
    const runtime = metaMap.get(id) || eye || {};
    const status = String(eye && eye.status || '').toLowerCase();
    const parserAllowsEmptySuccess = runtime.empty_success_is_signal === true;
    if (status === 'dormant') continue;
    const cooldownUntilMs = toMs(eye && eye.cooldown_until || null);
    if (cooldownUntilMs != null && cooldownUntilMs > now) continue;
    const selfHealCooldownUntilMs = toMs(eye && eye.self_heal_cooldown_until || null);
    if (selfHealCooldownUntilMs != null && selfHealCooldownUntilMs > now) continue;
    monitoredTotal += 1;
    const cadenceHours = Number(eye && eye.cadence_hours || 0);
    const staleThresholdHours = Math.max(
      Number(DARK_EYE_MAX_IDLE_HOURS || 12),
      Number.isFinite(cadenceHours) && cadenceHours > 0 ? (cadenceHours * 2) : 0
    );
    const lastSuccessMs = toMs(eye && (eye.last_success || eye.last_run || eye.last_real_signal_ts || null));
    const ageHours = hoursSince(lastSuccessMs, now);
    const consecutiveFailures = Number(eye && eye.consecutive_failures || 0);
    const stale = ageHours != null && ageHours >= staleThresholdHours;
    const lastErrorMs = toMs(eye && (eye.last_error_ts || eye.last_run || null));
    const lastErrorAgeHours = hoursSince(lastErrorMs, now);
    const baseFailCount = Number(DARK_EYE_FAIL_COUNT || 2);
    const failCountThreshold = Math.max(
      baseFailCount,
      Number.isFinite(cadenceHours) && cadenceHours > 0
        ? Math.ceil(staleThresholdHours / cadenceHours)
        : baseFailCount
    );
    const recentFailure = lastErrorAgeHours != null && lastErrorAgeHours <= staleThresholdHours;
    const explicitFailing = status === 'failing';
    const failing = (
      (explicitFailing && (parserAllowsEmptySuccess !== true || stale || recentFailure || consecutiveFailures >= failCountThreshold))
      || (consecutiveFailures >= failCountThreshold && (stale || recentFailure))
    );
    const healthyEmptySignal = (
      parserAllowsEmptySuccess === true
      && stale !== true
      && consecutiveFailures <= 0
      && recentFailure !== true
    );
    if (healthyEmptySignal) continue;
    if (stale || failing) {
      dark.push({
        id,
        status,
        parser_type: String(runtime && runtime.parser_type || '').toLowerCase() || null,
        empty_success_is_signal: parserAllowsEmptySuccess === true,
        age_hours: ageHours,
        cadence_hours: Number.isFinite(cadenceHours) ? cadenceHours : null,
        stale_threshold_hours: Number(staleThresholdHours.toFixed(2)),
        consecutive_failures: consecutiveFailures,
        fail_count_threshold: failCountThreshold,
        stale,
        failing,
        failure_recent: recentFailure,
        last_error_age_hours: lastErrorAgeHours
      });
    }
  }
  const total = monitoredTotal;
  const count = dark.length;
  const criticalThreshold = Math.max(
    Number(DARK_EYE_CRITICAL_MIN || 2),
    Math.ceil(Number(total || 0) * Number(DARK_EYE_CRITICAL_RATIO || 0.4))
  );
  const level = count >= criticalThreshold ? 'critical' : (count > 0 ? 'warn' : 'ok');
  return {
    name: 'dark_eyes',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'all_eyes_recent_or_healthy'
      : `dark_eyes=${count}/${total}`,
    metrics: {
      total_eyes: total,
      dark_count: count,
      dark_ids: dark.slice(0, 12).map((d) => d.id),
      max_age_hours: dark.reduce((m, d) => (d.age_hours != null && d.age_hours > m ? d.age_hours : m), 0)
    },
    thresholds: {
      max_idle_hours: Number(DARK_EYE_MAX_IDLE_HOURS || 12),
      cadence_multiplier: 2,
      fail_count: Number(DARK_EYE_FAIL_COUNT || 2),
      fail_count_dynamic: true,
      critical_count: criticalThreshold
    },
    details: dark.slice(0, 20)
  };
}

function assessProposalStarvation(now, proposalRows, queueEvents, runEvents, autonomyEnabled = true) {
  const terminalProposalIds = new Set();
  for (const evt of (Array.isArray(queueEvents) ? queueEvents : [])) {
    if (!evt || typeof evt !== 'object') continue;
    const pid = String(evt.proposal_id || '').trim();
    if (!pid) continue;
    const t = String(evt.type || '').trim().toLowerCase();
    if (t === 'outcome') {
      terminalProposalIds.add(pid);
      continue;
    }
    if (t === 'decision' && isTerminalQueueDecision(evt.decision)) {
      terminalProposalIds.add(pid);
    }
  }
  const eligible = proposalRows.filter((row) => {
    const p = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
    const proposalId = String(p.id || '').trim();
    if (proposalId && terminalProposalIds.has(proposalId)) return false;
    const explicitStatus = String(p.status || p.state || '').trim().toLowerCase();
    if (
      explicitStatus === 'resolved'
      || explicitStatus === 'done'
      || explicitStatus === 'closed'
      || explicitStatus === 'shipped'
      || explicitStatus === 'no_change'
      || explicitStatus === 'reverted'
      || explicitStatus === 'rejected'
      || explicitStatus === 'filtered'
      || explicitStatus === 'superseded'
      || explicitStatus === 'archived'
      || explicitStatus === 'dropped'
    ) return false;
    const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
    const admission = meta.admission_preview && typeof meta.admission_preview === 'object'
      ? meta.admission_preview
      : null;
    return !!(admission && admission.eligible === true);
  });
  const acceptedEvents = queueEvents.filter((e) => e && e.type === 'decision' && String(e.decision || '') === 'accept');
  const outcomeEvents = queueEvents.filter((e) => e && e.type === 'outcome');
  const lastQueueProgress = lastTs(queueEvents, (e) => {
    if (!e || !e.type) return false;
    if (e.type === 'outcome') return true;
    return e.type === 'decision' && String(e.decision || '') === 'accept';
  });
  const lastExecuted = lastTs(runEvents, (e) => String(e.result || '') === 'executed');
  const lastProgress = [lastQueueProgress, lastExecuted]
    .filter((x) => Number.isFinite(Number(x)))
    .reduce((m, x) => (m == null || x > m ? x : m), null);
  const ageHours = hoursSince(lastProgress, now);
  const eligibleCount = eligible.length;
  const executedCount = runEvents.filter((e) => String(e.result || '') === 'executed').length;
  const quotaDeficit = Number(STARVATION_MIN_DAILY_EXECUTIONS || 0) > 0
    && eligibleCount > 0
    && executedCount < Number(STARVATION_MIN_DAILY_EXECUTIONS || 0);
  const quotaGraceHours = Number.isFinite(Number(STARVATION_QUOTA_GRACE_HOURS))
    ? Math.max(1, Number(STARVATION_QUOTA_GRACE_HOURS))
    : 8;
  const quotaWarn = quotaDeficit
    && (ageHours == null || ageHours >= quotaGraceHours);
  if (!autonomyEnabled) {
    const previewWarn = eligibleCount >= Number(STARVATION_PREVIEW_WARN_ELIGIBLE || STARVATION_MIN_ELIGIBLE || 3)
      && (ageHours == null || ageHours >= Number(STARVATION_PREVIEW_WARN_HOURS || STARVATION_WARN_HOURS || 18));
    const level = previewWarn ? 'warn' : 'ok';
    return {
      name: 'proposal_starvation',
      ok: level === 'ok',
      level,
      reason: previewWarn ? 'autonomy_disabled_starvation_preview' : 'autonomy_disabled_manual_mode',
      metrics: {
        eligible_count: eligibleCount,
        queue_accept_count: acceptedEvents.length,
        queue_outcome_count: outcomeEvents.length,
        run_executed_count: executedCount,
        min_daily_executions: Number(STARVATION_MIN_DAILY_EXECUTIONS || 0),
        execution_quota_deficit: quotaDeficit,
        last_progress_ts: lastProgress ? new Date(lastProgress).toISOString() : null,
        hours_since_progress: ageHours
      },
      thresholds: {
        min_eligible: Number(STARVATION_MIN_ELIGIBLE || 3),
        preview_warn_eligible: Number(STARVATION_PREVIEW_WARN_ELIGIBLE || STARVATION_MIN_ELIGIBLE || 3),
        preview_warn_hours: Number(STARVATION_PREVIEW_WARN_HOURS || STARVATION_WARN_HOURS || 18),
        warn_hours: Number(STARVATION_WARN_HOURS || 18),
        critical_hours: Number(STARVATION_CRITICAL_HOURS || 36),
        critical_eligible: Number(STARVATION_CRITICAL_ELIGIBLE || 6),
        min_daily_executions: Number(STARVATION_MIN_DAILY_EXECUTIONS || 0),
        quota_grace_hours: quotaGraceHours
      }
    };
  }
  const warn = eligibleCount >= Number(STARVATION_MIN_ELIGIBLE || 3)
    && (ageHours == null || ageHours >= Number(STARVATION_WARN_HOURS || 18));
  const critical = eligibleCount >= Number(STARVATION_CRITICAL_ELIGIBLE || 6)
    && (ageHours == null || ageHours >= Number(STARVATION_CRITICAL_HOURS || 36));
  const level = critical ? 'critical' : ((warn || quotaWarn) ? 'warn' : 'ok');
  return {
    name: 'proposal_starvation',
    ok: level === 'ok',
    level,
    reason: critical
      ? `eligible=${eligibleCount} age_hours=${ageHours == null ? 'none' : ageHours}`
      : (quotaWarn
        ? `daily_execution_quota_deficit executed=${executedCount} required=${Number(STARVATION_MIN_DAILY_EXECUTIONS || 0)}`
        : (level === 'ok'
          ? 'eligible_proposals_have_recent_progress'
          : `eligible=${eligibleCount} age_hours=${ageHours == null ? 'none' : ageHours}`)),
    metrics: {
      eligible_count: eligibleCount,
      queue_accept_count: acceptedEvents.length,
      queue_outcome_count: outcomeEvents.length,
      run_executed_count: executedCount,
      min_daily_executions: Number(STARVATION_MIN_DAILY_EXECUTIONS || 0),
      execution_quota_deficit: quotaDeficit,
      last_progress_ts: lastProgress ? new Date(lastProgress).toISOString() : null,
      hours_since_progress: ageHours
    },
    thresholds: {
      min_eligible: Number(STARVATION_MIN_ELIGIBLE || 3),
      warn_hours: Number(STARVATION_WARN_HOURS || 18),
      critical_hours: Number(STARVATION_CRITICAL_HOURS || 36),
      critical_eligible: Number(STARVATION_CRITICAL_ELIGIBLE || 6),
      min_daily_executions: Number(STARVATION_MIN_DAILY_EXECUTIONS || 0),
      quota_grace_hours: quotaGraceHours
    }
  };
}

function isTerminalQueueDecision(decision): boolean {
  const d = String(decision || '').trim().toLowerCase();
  return d === 'reject'
    || d === 'rejected'
    || d === 'done'
    || d === 'filtered'
    || d === 'superseded'
    || d === 'archive'
    || d === 'archived'
    || d === 'drop'
    || d === 'dropped'
    || d === 'closed';
}

function proposalTimestamp(row): number | null {
  const p = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
  return toMs(p.ts || p.updated_at || p.created_at || p.collected_at || `${String(row && row.date || '')}T00:00:00.000Z`);
}

function assessQueueBacklog(now, proposalRows, queueEvents, windowDays = 1, autonomyEnabled = true) {
  const latestById = new Map<string, { row: AnyObj; ts: number }>();
  for (const row of proposalRows || []) {
    const p = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
    const id = String(p.id || '').trim();
    if (!id) continue;
    const ts = proposalTimestamp(row) || 0;
    const prev = latestById.get(id);
    const prevTs = prev ? Number(prev.ts || 0) : 0;
    if (!prev || ts >= prevTs) latestById.set(id, { row, ts });
  }

  const queueState = new Map<string, { terminal: boolean; decision: string }>();
  let decisions = 0;
  let outcomes = 0;
  for (const ev of queueEvents || []) {
    if (!ev || typeof ev !== 'object') continue;
    const id = String(ev.proposal_id || ev.id || '').trim();
    if (!id) continue;
    if (String(ev.type || '') === 'decision') {
      decisions += 1;
      const decision = String(ev.decision || '').trim().toLowerCase();
      if (isTerminalQueueDecision(decision)) queueState.set(id, { terminal: true, decision });
      else if (decision === 'accept' || decision === 'admit' || decision === 'queued') queueState.set(id, { terminal: false, decision });
    } else if (String(ev.type || '') === 'outcome') {
      outcomes += 1;
    }
  }

  const activeRows: Array<{ id: string; ts: number; proposal: AnyObj }> = [];
  let contractDivergence = 0;
  let queueTerminalCount = 0;
  let proposalTerminalCount = 0;
  let queueTerminalWithoutProposalTerminal = 0;
  let proposalTerminalWithQueueNonTerminal = 0;
  for (const [id, entry] of latestById.entries()) {
    const p = entry && entry.row && entry.row.proposal && typeof entry.row.proposal === 'object'
      ? entry.row.proposal
      : {};
    const explicitStatus = String(p.status || '').trim().toLowerCase();
    const explicitTerminal = ['rejected', 'reject', 'done', 'filtered', 'superseded', 'archived', 'closed', 'dropped', 'shipped', 'reverted', 'no_change', 'resolved'].includes(explicitStatus);
    const queue = queueState.get(id);
    const queueTerminal = queue && queue.terminal === true;
    if (queueTerminal) queueTerminalCount += 1;
    if (explicitTerminal) proposalTerminalCount += 1;
    if (queue && queueTerminal && !explicitTerminal) {
      contractDivergence += 1;
      queueTerminalWithoutProposalTerminal += 1;
    } else if (queue && queueTerminal === false && explicitTerminal) {
      contractDivergence += 1;
      proposalTerminalWithQueueNonTerminal += 1;
    }
    const terminal = queueTerminal || explicitTerminal;
    if (terminal) continue;
    activeRows.push({ id, ts: Number(entry.ts || 0), proposal: p });
  }

  const openAges = activeRows
    .map((row) => hoursSince(row.ts, now))
    .filter((n) => Number.isFinite(Number(n)))
    .map((n) => Number(n));

  const openCount = activeRows.length;
  const rawOpenCount = latestById.size;
  const warnAged = openAges.filter((n) => n >= Number(QUEUE_BACKLOG_WARN_AGE_HOURS || 24)).length;
  const criticalAged = openAges.filter((n) => n >= Number(QUEUE_BACKLOG_CRITICAL_AGE_HOURS || 72)).length;
  const oldestHours = openAges.length ? Number(Math.max(...openAges).toFixed(3)) : null;
  const queueProgress = decisions + outcomes;
  const progressPerDay = Number((queueProgress / Math.max(1, Number(windowDays || 1))).toFixed(3));

  if (!autonomyEnabled) {
    return {
      name: 'queue_backlog',
      ok: true,
      level: 'ok',
      reason: 'autonomy_disabled_manual_mode',
      metrics: {
        open_count: openCount,
        unique_proposals: rawOpenCount,
        queue_contract_divergence: contractDivergence,
        queue_terminal_count: queueTerminalCount,
        proposal_terminal_count: proposalTerminalCount,
        queue_terminal_without_proposal_terminal: queueTerminalWithoutProposalTerminal,
        proposal_terminal_with_queue_non_terminal: proposalTerminalWithQueueNonTerminal,
        queue_progress_events: queueProgress,
        queue_progress_per_day: progressPerDay,
        aged_open_warn_count: warnAged,
        aged_open_critical_count: criticalAged,
        oldest_open_hours: oldestHours
      },
      thresholds: {
        warn_open: Number(QUEUE_BACKLOG_WARN_OPEN || 40),
        critical_open: Number(QUEUE_BACKLOG_CRITICAL_OPEN || 80),
        warn_divergence: Number(QUEUE_BACKLOG_DIVERGENCE_WARN || 12),
        critical_divergence: Number(QUEUE_BACKLOG_DIVERGENCE_CRITICAL || 30),
        warn_age_hours: Number(QUEUE_BACKLOG_WARN_AGE_HOURS || 24),
        critical_age_hours: Number(QUEUE_BACKLOG_CRITICAL_AGE_HOURS || 72)
      }
    };
  }

  const critical = openCount >= Number(QUEUE_BACKLOG_CRITICAL_OPEN || 80)
    || criticalAged > 0
    || contractDivergence >= Number(QUEUE_BACKLOG_DIVERGENCE_CRITICAL || 30);
  const warn = !critical && (
    openCount >= Number(QUEUE_BACKLOG_WARN_OPEN || 40)
    || warnAged > 0
    || contractDivergence >= Number(QUEUE_BACKLOG_DIVERGENCE_WARN || 12)
  );
  const level = critical ? 'critical' : (warn ? 'warn' : 'ok');

  return {
    name: 'queue_backlog',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'queue_backlog_within_slo'
      : `open=${openCount} aged_warn=${warnAged} aged_critical=${criticalAged}`,
    metrics: {
      open_count: openCount,
      unique_proposals: rawOpenCount,
      queue_contract_divergence: contractDivergence,
      queue_terminal_count: queueTerminalCount,
      proposal_terminal_count: proposalTerminalCount,
      queue_terminal_without_proposal_terminal: queueTerminalWithoutProposalTerminal,
      proposal_terminal_with_queue_non_terminal: proposalTerminalWithQueueNonTerminal,
      queue_progress_events: queueProgress,
      queue_progress_per_day: progressPerDay,
      aged_open_warn_count: warnAged,
      aged_open_critical_count: criticalAged,
      oldest_open_hours: oldestHours
    },
    thresholds: {
      warn_open: Number(QUEUE_BACKLOG_WARN_OPEN || 40),
      critical_open: Number(QUEUE_BACKLOG_CRITICAL_OPEN || 80),
      warn_divergence: Number(QUEUE_BACKLOG_DIVERGENCE_WARN || 12),
      critical_divergence: Number(QUEUE_BACKLOG_DIVERGENCE_CRITICAL || 30),
      warn_age_hours: Number(QUEUE_BACKLOG_WARN_AGE_HOURS || 24),
      critical_age_hours: Number(QUEUE_BACKLOG_CRITICAL_AGE_HOURS || 72)
    }
  };
}

function assessLoopStall(now, runEvents, autonomyEnabled = true) {
  const lastRun = lastTs(runEvents, () => true);
  const ageHours = hoursSince(lastRun, now);
  const runs24h = runEvents.filter((e) => {
    const t = toMs(e && e.ts);
    return Number.isFinite(t) && (now - t) <= 24 * 3600 * 1000;
  }).length;
  if (!autonomyEnabled) {
    return {
      name: 'loop_stall',
      ok: true,
      level: 'ok',
      reason: 'autonomy_disabled_manual_mode',
      metrics: {
        autonomy_enabled: false,
        runs_window: runEvents.length,
        runs_last_24h: runs24h,
        last_run_ts: lastRun ? new Date(lastRun).toISOString() : null,
        hours_since_last_run: ageHours
      },
      thresholds: {
        warn_hours: Number(LOOP_STALL_WARN_HOURS || 8),
        critical_hours: Number(LOOP_STALL_CRITICAL_HOURS || 24)
      }
    };
  }
  let level = 'ok';
  if (ageHours == null || ageHours >= Number(LOOP_STALL_CRITICAL_HOURS || 24)) level = 'critical';
  else if (ageHours >= Number(LOOP_STALL_WARN_HOURS || 8) || runs24h === 0) level = 'warn';
  return {
    name: 'loop_stall',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'autonomy_loop_recent'
      : `hours_since_last_run=${ageHours == null ? 'none' : ageHours}`,
    metrics: {
      autonomy_enabled: true,
      runs_window: runEvents.length,
      runs_last_24h: runs24h,
      last_run_ts: lastRun ? new Date(lastRun).toISOString() : null,
      hours_since_last_run: ageHours
    },
    thresholds: {
      warn_hours: Number(LOOP_STALL_WARN_HOURS || 8),
      critical_hours: Number(LOOP_STALL_CRITICAL_HOURS || 24)
    }
  };
}

function assessDrift(spcResult, autonomyEnabled = true) {
  const payload = spcResult && spcResult.payload && typeof spcResult.payload === 'object'
    ? spcResult.payload
    : null;
  if (!spcResult.ok || !payload || payload.ok !== true) {
    return {
      name: 'drift',
      ok: false,
      level: 'warn',
      reason: 'spc_unavailable',
      metrics: {
        spc_ok: false,
        failed_checks: [],
        hold_escalation: null
      },
      thresholds: {
        baseline_days: Number(SPC_BASELINE_DAYS || 21),
        sigma: Number(SPC_SIGMA || 3)
      }
    };
  }
  const failed = Array.isArray(payload.failed_checks) ? payload.failed_checks : [];
  const current = payload.current && typeof payload.current === 'object'
    ? payload.current
    : {};
  const outcomeDependentChecks = new Set([
    'attempted',
    'executed',
    'success_criteria_receipts',
    'success_criteria_pass_rate'
  ]);
  const onlyOutcomeDataGap = failed.length > 0 && failed.every((id) => outcomeDependentChecks.has(String(id || '')));
  const passRateOnlyFailure = failed.length === 1 && failed[0] === 'success_criteria_pass_rate';
  const stopRatioOnlyFailure = failed.length === 1 && failed[0] === 'stop_ratio';
  const source = String(current.success_criteria_source || 'legacy_fallback');
  const fallbackRetired = current.success_criteria_fallback_retired === true;
  const attempted = Number(current.attempted || 0);
  const admissionEvidence = Number(current.admission_evidence || 0);
  const deferLowSampleOutcomeGap = onlyOutcomeDataGap
    && attempted <= 0
    && admissionEvidence >= 1;
  const stopRatioSource = String(current.stop_ratio_source || 'all');
  const stopRatioDenominator = Number(current.stop_ratio_denominator || 0);
  const deferStopRatioLowSample = stopRatioOnlyFailure
    && stopRatioSource === 'quality'
    && stopRatioDenominator > 0
    && stopRatioDenominator < Number(SPC_STOP_RATIO_MIN_DENOM || 4);
  const deferPassRateWarn = passRateOnlyFailure && !fallbackRetired && source !== 'quality_forced';
  const deferManualOutcomeGaps = !autonomyEnabled && onlyOutcomeDataGap;
  const level = deferLowSampleOutcomeGap
    ? 'ok'
    : deferStopRatioLowSample
    ? 'ok'
    : deferPassRateWarn
    ? 'ok'
    : deferManualOutcomeGaps
      ? 'ok'
      : (failed.length >= 2 ? 'critical' : (failed.length > 0 ? 'warn' : 'ok'));
  const reason = deferLowSampleOutcomeGap
    ? 'spc_low_sample_outcome_gap_nonblocking'
    : deferStopRatioLowSample
    ? 'spc_quality_stopratio_low_sample_nonblocking'
    : deferPassRateWarn
    ? 'spc_pre_retirement_quality_passrate_nonblocking'
    : deferManualOutcomeGaps
      ? 'spc_preview_outcome_data_gap_manual_mode'
      : (level === 'ok' ? 'spc_in_control' : `spc_failed=${failed.join(',')}`);
  return {
    name: 'drift',
    ok: level === 'ok',
    level,
    reason,
    metrics: {
      autonomy_enabled: !!autonomyEnabled,
      spc_ok: true,
      hold_escalation: payload.hold_escalation === true,
      failed_checks: failed,
      success_criteria_source: source,
      success_criteria_fallback_retired: fallbackRetired,
      stop_ratio_source: stopRatioSource,
      stop_ratio_denominator: stopRatioDenominator,
      attempted,
      admission_evidence: admissionEvidence,
      deferred_low_sample_outcome_gap: deferLowSampleOutcomeGap,
      deferred_stopratio_low_sample: deferStopRatioLowSample,
      deferred_passrate_warning: deferPassRateWarn,
      deferred_manual_outcome_gap: deferManualOutcomeGaps
    },
    thresholds: {
      baseline_days: payload.control ? Number(payload.control.baseline_days || SPC_BASELINE_DAYS) : Number(SPC_BASELINE_DAYS || 21),
      sigma: payload.control ? Number(payload.control.sigma || SPC_SIGMA) : Number(SPC_SIGMA || 3),
      stop_ratio_min_denominator: Number(SPC_STOP_RATIO_MIN_DENOM || 4)
    }
  };
}

function assessRoutingDegraded(routing) {
  const downConsecutive = Number(routing && routing.spine_local_down_consecutive || 0);
  const doctor = routing && routing.doctor_summary && typeof routing.doctor_summary === 'object'
    ? routing.doctor_summary
    : {};
  const runtime = routing && routing.doctor_runtime && typeof routing.doctor_runtime === 'object'
    ? routing.doctor_runtime
    : {};
  const doctorReason = String(doctor.reason || '').trim().toLowerCase();
  const localEligible = Number(runtime.local_eligible_models || 0);
  const softEscalate = (
    doctor.escalate === true
    && downConsecutive <= 0
    && localEligible > 0
    && (doctorReason === 'local_latency_slow' || doctorReason === 'local_latency_moderate')
  );
  let level = 'ok';
  if (downConsecutive >= Number(ROUTING_DOWN_CRITICAL || 3)) {
    level = 'critical';
  } else if (
    downConsecutive >= Number(ROUTING_DOWN_WARN || 1)
    || (doctor.escalate === true && !softEscalate)
    || localEligible <= 0
  ) {
    level = 'warn';
  }
  return {
    name: 'routing_degraded',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? (softEscalate ? 'local_routing_healthy_soft_latency_escalation' : 'local_routing_healthy')
      : `down_consecutive=${downConsecutive} escalate=${doctor.escalate === true}`,
    metrics: {
      spine_local_down_consecutive: downConsecutive,
      doctor_escalate: doctor.escalate === true,
      doctor_reason: doctorReason || null,
      local_total_models: Number(runtime.total_local_models || 0),
      local_eligible_models: localEligible,
      stale_local_records: Number(runtime.stale_local_records || 0)
    },
    thresholds: {
      warn_down_consecutive: Number(ROUTING_DOWN_WARN || 1),
      critical_down_consecutive: Number(ROUTING_DOWN_CRITICAL || 3),
      min_local_eligible_models: 1
    }
  };
}

function assessRoutingRecoveryPulse(routing, autonomyEnabled = true) {
  const pulse = routing && routing.recovery_pulse && typeof routing.recovery_pulse === 'object'
    ? routing.recovery_pulse
    : {};
  const runtime = routing && routing.doctor_runtime && typeof routing.doctor_runtime === 'object'
    ? routing.doctor_runtime
    : {};
  const doctor = routing && routing.doctor_summary && typeof routing.doctor_summary === 'object'
    ? routing.doctor_summary
    : {};
  const downConsecutive = Number(routing && routing.spine_local_down_consecutive || 0);
  const localTotal = Number(runtime.total_local_models || 0);
  const pulseEvents = Number(pulse.pulse_events || 0);
  const ageHours = Number(pulse.last_pulse_age_hours);
  const recoveredTotal = Number(pulse.recovered_total || 0);
  const eligible = Number(runtime.local_eligible_models || 0);
  const doctorEscalate = doctor.escalate === true;

  let level = 'ok';
  let reason = 'routing_recovery_pulse_healthy';
  const stableLocalManualMode = (
    !autonomyEnabled
    && localTotal > 0
    && eligible > 0
    && downConsecutive <= 0
    && doctorEscalate !== true
  );
  if (stableLocalManualMode && pulseEvents <= 0) {
    level = 'ok';
    reason = 'routing_recovery_pulse_not_required_manual_mode';
  } else if (localTotal > 0 && pulseEvents <= 0) {
    level = 'warn';
    reason = 'routing_recovery_pulse_missing';
  } else if (localTotal > 0 && Number.isFinite(ageHours) && ageHours >= Number(ROUTING_RECOVERY_CRITICAL_HOURS || 72)) {
    level = 'critical';
    reason = 'routing_recovery_pulse_stale_critical';
  } else if (localTotal > 0 && Number.isFinite(ageHours) && ageHours >= Number(ROUTING_RECOVERY_WARN_HOURS || 24)) {
    level = 'warn';
    reason = 'routing_recovery_pulse_stale_warn';
  } else if (localTotal > 0 && eligible <= 0 && recoveredTotal <= 0) {
    level = 'warn';
    reason = 'routing_recovery_no_local_recovery';
  }

  return {
    name: 'routing_recovery_pulse',
    ok: level === 'ok',
    level,
    reason,
    metrics: {
      autonomy_enabled: !!autonomyEnabled,
      local_total_models: localTotal,
      local_eligible_models: eligible,
      doctor_escalate: doctorEscalate,
      spine_local_down_consecutive: downConsecutive,
      pulse_events: pulseEvents,
      warmed_total: Number(pulse.warmed_total || 0),
      recovered_total: recoveredTotal,
      skipped_interval_count: Number(pulse.skipped_interval_count || 0),
      last_pulse_ts: pulse.last_pulse_ts || null,
      last_pulse_age_hours: Number.isFinite(ageHours) ? ageHours : null
    },
    thresholds: {
      warn_age_hours: Number(ROUTING_RECOVERY_WARN_HOURS || 24),
      critical_age_hours: Number(ROUTING_RECOVERY_CRITICAL_HOURS || 72)
    }
  };
}

function assessBudgetGuard(now, dateSet) {
  const events = readJsonl(SYSTEM_BUDGET_EVENTS_PATH);
  const allowedDates = new Set(Array.isArray(dateSet) ? dateSet.map((d) => String(d || '')) : []);
  const scoped = events.filter((row) => {
    const evt = row && typeof row === 'object' ? row : {};
    const evtDate = String(evt.date || '').trim();
    if (evtDate && allowedDates.size > 0) return allowedDates.has(evtDate);
    const tsDay = String(evt.ts || '').slice(0, 10);
    return tsDay && allowedDates.size > 0 ? allowedDates.has(tsDay) : true;
  });
  const decisions = scoped.filter((row) => String(row && row.type || '') === 'system_budget_decision');
  const denies = decisions.filter((row) => String(row && row.decision || '') === 'deny');
  const degrades = decisions.filter((row) => String(row && row.decision || '') === 'degrade');
  const allows = decisions.filter((row) => String(row && row.decision || '') === 'allow');
  const reasonCounts = {};
  for (const row of denies) {
    const reason = String(row && row.reason || '').trim() || 'unknown';
    reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
  }
  const topDenyReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count: Number(count || 0) }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason))
    .slice(0, 5);

  const autopauseRaw = readJson(SYSTEM_BUDGET_AUTOPAUSE_PATH, null);
  const untilMs = Number(autopauseRaw && autopauseRaw.until_ms || 0);
  const rawActive = !!(autopauseRaw && autopauseRaw.active === true && Number.isFinite(untilMs) && untilMs > Number(now || Date.now()));
  const autopauseSource = autopauseRaw && autopauseRaw.source ? String(autopauseRaw.source) : null;
  const autopausePressure = autopauseRaw && autopauseRaw.pressure
    ? String(autopauseRaw.pressure).trim().toLowerCase()
    : null;
  const staleRecoveredPause = rawActive
    && autopauseSource === 'spine_budget_guard'
    && autopausePressure === 'none';
  const active = rawActive && !staleRecoveredPause;
  const autonomyEnabled = String(process.env.AUTONOMY_ENABLED || '0') === '1';
  const lastDecisionTs = lastTs(decisions, () => true);

  let level = 'ok';
  let reason = 'budget_guard_healthy';
  if (staleRecoveredPause) {
    level = 'warn';
    reason = 'budget_autopause_stale_recovered_pressure';
  } else if (active) {
    level = autonomyEnabled ? 'critical' : 'warn';
    reason = autonomyEnabled ? 'budget_autopause_active' : 'budget_autopause_active_preview_only';
  } else if (denies.length > 0) {
    level = autonomyEnabled ? 'warn' : 'ok';
    reason = autonomyEnabled ? 'budget_guard_denies_present' : 'budget_guard_denies_preview_only';
  } else if (degrades.length >= Number(BUDGET_DEGRADE_WARN_COUNT || 3)) {
    level = 'warn';
    reason = 'budget_guard_degrade_pressure';
  }

  return {
    name: 'budget_guard',
    ok: level === 'ok',
    level,
    reason,
    metrics: {
      autopause_active: active,
      autopause_source: autopauseSource,
      autopause_pressure: autopausePressure,
      autopause_stale_recovered_pressure: staleRecoveredPause,
      autopause_reason: autopauseRaw && autopauseRaw.reason ? String(autopauseRaw.reason) : null,
      autopause_until: active ? new Date(untilMs).toISOString() : null,
      autonomy_enabled: autonomyEnabled,
      decision_allow_count: allows.length,
      decision_degrade_count: degrades.length,
      decision_deny_count: denies.length,
      decision_total: decisions.length,
      top_deny_reasons: topDenyReasons,
      last_decision_ts: lastDecisionTs ? new Date(lastDecisionTs).toISOString() : null
    },
    thresholds: {
      degrade_warn_count: Number(BUDGET_DEGRADE_WARN_COUNT || 3)
    }
  };
}

function assessDreamDegradation(now, dateSet, autonomyEnabled = true) {
  const rows = readIdleDreamEvents(dateSet);
  const cycleRuns = rows.filter((row) => String(row && row.type || '') === 'idle_dream_cycle_run');
  const preflightFailed = rows.filter((row) => (
    String(row && row.type || '') === 'idle_dream_model_preflight'
    && String(row && row.result || '').toLowerCase() === 'failed'
  ));
  const degradedRuns = cycleRuns.filter((row) => {
    const idleOk = row && row.idle_ok === true;
    const idleReason = String(row && row.idle_reason || '').toLowerCase();
    if (!idleOk) return true;
    return idleReason.includes('fallback');
  });
  const fallbackRuns = cycleRuns.filter((row) => String(row && row.idle_reason || '').toLowerCase().includes('fallback'));
  const cycleCount = cycleRuns.length;
  const degradedCount = degradedRuns.length;
  const degradedRatio = cycleCount > 0 ? Number((degradedCount / cycleCount).toFixed(3)) : 0;
  const fallbackCount = fallbackRuns.length;
  const preflightFailCount = preflightFailed.length;
  const lastCycleTs = lastTs(cycleRuns, () => true);
  const ageHours = hoursSince(lastCycleTs, now);

  let level = 'ok';
  let reason = 'dream_cycle_healthy';
  if (cycleCount <= 0) {
    level = autonomyEnabled ? 'critical' : 'warn';
    reason = autonomyEnabled ? 'dream_cycle_missing' : 'dream_cycle_missing_preview_only';
  } else if (Number.isFinite(ageHours) && ageHours >= Number(DREAM_MISSING_RUN_CRITICAL_HOURS || 24)) {
    level = autonomyEnabled ? 'critical' : 'warn';
    reason = autonomyEnabled ? 'dream_cycle_stale_critical' : 'dream_cycle_stale_preview_only';
  } else if (degradedRatio >= Number(DREAM_DEGRADE_CRITICAL_RATIO || 0.75)) {
    level = autonomyEnabled ? 'critical' : 'warn';
    reason = autonomyEnabled ? 'dream_cycle_degraded_critical' : 'dream_cycle_degraded_preview_only';
  } else if (
    degradedRatio >= Number(DREAM_DEGRADE_WARN_RATIO || 0.35)
    || fallbackCount >= Number(DREAM_FALLBACK_WARN_COUNT || 2)
    || preflightFailCount >= Number(DREAM_PREFLIGHT_FAIL_WARN_COUNT || 3)
    || (Number.isFinite(ageHours) && ageHours >= Number(DREAM_MISSING_RUN_WARN_HOURS || 12))
  ) {
    level = 'warn';
    reason = 'dream_cycle_degraded_warn';
  }

  return {
    name: 'dream_degradation',
    ok: level === 'ok',
    level,
    reason,
    metrics: {
      autonomy_enabled: !!autonomyEnabled,
      cycle_runs: cycleCount,
      degraded_runs: degradedCount,
      degraded_ratio: degradedRatio,
      fallback_runs: fallbackCount,
      preflight_failed_count: preflightFailCount,
      last_cycle_ts: lastCycleTs ? new Date(lastCycleTs).toISOString() : null,
      last_cycle_age_hours: Number.isFinite(ageHours) ? ageHours : null
    },
    thresholds: {
      warn_degraded_ratio: Number(DREAM_DEGRADE_WARN_RATIO || 0.35),
      critical_degraded_ratio: Number(DREAM_DEGRADE_CRITICAL_RATIO || 0.75),
      warn_fallback_count: Number(DREAM_FALLBACK_WARN_COUNT || 2),
      warn_preflight_failed_count: Number(DREAM_PREFLIGHT_FAIL_WARN_COUNT || 3),
      warn_missing_run_hours: Number(DREAM_MISSING_RUN_WARN_HOURS || 12),
      critical_missing_run_hours: Number(DREAM_MISSING_RUN_CRITICAL_HOURS || 24)
    }
  };
}

function assessRouteAttestation(receiptSummaryResult) {
  const payload = receiptSummaryResult && receiptSummaryResult.payload && typeof receiptSummaryResult.payload === 'object'
    ? receiptSummaryResult.payload
    : {};
  const receipts = payload && payload.receipts && typeof payload.receipts === 'object'
    ? payload.receipts
    : {};
  const combined = receipts.combined && typeof receipts.combined === 'object' ? receipts.combined : {};
  const autonomy = receipts.autonomy && typeof receipts.autonomy === 'object' ? receipts.autonomy : {};
  const reasonMap = (combined.top_failure_reasons && typeof combined.top_failure_reasons === 'object')
    ? combined.top_failure_reasons
    : ((autonomy.top_failure_reasons && typeof autonomy.top_failure_reasons === 'object') ? autonomy.top_failure_reasons : {});
  let mismatchFailures = 0;
  const matchedReasons = [];
  for (const [reason, countRaw] of Object.entries(reasonMap)) {
    const reasonText = String(reason || '').toLowerCase();
    if (!reasonText.includes('route_model_attested') && !reasonText.includes('route_model_mismatch')) continue;
    const count = Number(countRaw || 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    mismatchFailures += count;
    matchedReasons.push({ reason: String(reason || ''), count });
  }
  matchedReasons.sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
  let level = 'ok';
  if (mismatchFailures >= Number(ROUTE_ATTESTATION_CRITICAL || 3)) level = 'critical';
  else if (mismatchFailures >= Number(ROUTE_ATTESTATION_WARN || 1)) level = 'warn';
  return {
    name: 'route_attestation',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'route_model_attestation_clean'
      : `route_model_attestation_failures=${mismatchFailures}`,
    metrics: {
      mismatch_failures: mismatchFailures,
      attempted_receipts: Number(combined.attempted || 0),
      verified_rate: Number.isFinite(Number(combined.verified_rate)) ? Number(combined.verified_rate) : null,
      matched_failure_reasons: matchedReasons.slice(0, 5)
    },
    thresholds: {
      warn: Number(ROUTE_ATTESTATION_WARN || 1),
      critical: Number(ROUTE_ATTESTATION_CRITICAL || 3)
    }
  };
}

function assessIntegrity(integrityResult) {
  const payload = integrityResult && integrityResult.payload && typeof integrityResult.payload === 'object'
    ? integrityResult.payload
    : null;
  const ok = !!(integrityResult.ok && payload && payload.ok === true);
  return {
    name: 'integrity',
    ok,
    level: ok ? 'ok' : 'critical',
    reason: ok ? 'integrity_kernel_ok' : 'integrity_kernel_failed',
    metrics: {
      kernel_ok: ok,
      expected_files: payload ? Number(payload.expected_files || 0) : null,
      checked_present_files: payload ? Number(payload.checked_present_files || 0) : null,
      violation_counts: payload && payload.violation_counts ? payload.violation_counts : {}
    },
    thresholds: {}
  };
}

function assessCriteriaQualityGate(strategyReadinessResult, receiptSummaryResult) {
  const readinessPayload = strategyReadinessResult && strategyReadinessResult.payload && typeof strategyReadinessResult.payload === 'object'
    ? strategyReadinessResult.payload
    : {};
  const readiness = readinessPayload && readinessPayload.readiness && typeof readinessPayload.readiness === 'object'
    ? readinessPayload.readiness
    : {};
  const metrics = readiness && readiness.metrics && typeof readiness.metrics === 'object'
    ? readiness.metrics
    : {};
  const receiptPayload = receiptSummaryResult && receiptSummaryResult.payload && typeof receiptSummaryResult.payload === 'object'
    ? receiptSummaryResult.payload
    : {};
  const autonomyReceipts = receiptPayload && receiptPayload.receipts && receiptPayload.receipts.autonomy && typeof receiptPayload.receipts.autonomy === 'object'
    ? receiptPayload.receipts.autonomy
    : {};

  const source = String(metrics.success_criteria_source || 'unknown');
  const fallbackRetired = metrics.success_criteria_fallback_retired === true;
  const qualityReceipts = Number(metrics.success_criteria_quality_receipts || autonomyReceipts.success_criteria_quality_receipts || 0);
  const legacyReceipts = Number(metrics.success_criteria_legacy_receipts || autonomyReceipts.success_criteria_receipts || 0);
  const disableFallbackAt = Number(metrics.disable_legacy_fallback_after_quality_receipts || 10);
  const maxInsufficientRate = Number(metrics.max_success_criteria_quality_insufficient_rate || 0.4);
  const insufficientRateRaw = Number(metrics.success_criteria_quality_insufficient_rate);
  const insufficientRate = Number.isFinite(insufficientRateRaw)
    ? insufficientRateRaw
    : Number(autonomyReceipts.success_criteria_quality_insufficient_rate || 0);
  const failedChecks = Array.isArray(readiness.failed_checks) ? readiness.failed_checks : [];
  const insufficientFail = failedChecks.includes('success_criteria_quality_insufficient_rate');
  const fallbackStale = source === 'legacy_fallback' && qualityReceipts >= disableFallbackAt;
  const enforced = fallbackRetired || source === 'quality_forced';

  let ok = true;
  let level = 'ok';
  let reason = 'criteria_quality_gate_ok';
  if (enforced && (insufficientFail || insufficientRate > maxInsufficientRate)) {
    ok = false;
    level = 'critical';
    reason = 'criteria_quality_insufficient_rate_high';
  } else if (insufficientFail || insufficientRate > maxInsufficientRate) {
    ok = false;
    level = 'warn';
    reason = 'criteria_quality_pre_retirement_high';
  } else if (fallbackStale || (!fallbackRetired && source === 'legacy_fallback' && qualityReceipts > 0)) {
    ok = false;
    level = 'warn';
    reason = fallbackStale ? 'criteria_quality_fallback_retirement_due' : 'criteria_quality_fallback_active';
  }

  return {
    name: 'criteria_quality_gate',
    ok,
    level,
    reason,
    metrics: {
      source,
      fallback_retired: fallbackRetired,
      enforced,
      quality_receipts: qualityReceipts,
      legacy_receipts: legacyReceipts,
      quality_insufficient_rate: Number(insufficientRate.toFixed(3)),
      readiness_failed_checks: failedChecks.slice(0, 6)
    },
    thresholds: {
      disable_legacy_fallback_after_quality_receipts: disableFallbackAt,
      max_success_criteria_quality_insufficient_rate: maxInsufficientRate
    }
  };
}

function assessStartupAttestation(verifyResult, telemetry) {
  const payload = verifyResult && verifyResult.payload && typeof verifyResult.payload === 'object'
    ? verifyResult.payload
    : {};
  const verifyOk = !!(verifyResult && verifyResult.ok && payload && payload.ok === true);
  const reason = String(payload && payload.reason || '').trim() || null;
  const ageHours = Number(telemetry && telemetry.last_verify_age_hours);
  const failCount = Number(telemetry && telemetry.verify_fail_count || 0);
  const okCount = Number(telemetry && telemetry.verify_ok_count || 0);
  const keyMissing = reason === 'attestation_key_missing';

  let level = 'ok';
  let checkReason = 'startup_attestation_verified';
  if (verifyOk !== true && !keyMissing) {
    level = 'critical';
    checkReason = reason ? `startup_attestation_verify_failed:${reason}` : 'startup_attestation_verify_failed';
  } else if (verifyOk !== true && keyMissing) {
    level = 'warn';
    checkReason = 'startup_attestation_key_missing';
  } else if (Number.isFinite(ageHours) && ageHours >= Number(STARTUP_ATTESTATION_CRITICAL_HOURS || 36)) {
    level = 'critical';
    checkReason = 'startup_attestation_verify_stale_critical';
  } else if (Number.isFinite(ageHours) && ageHours >= Number(STARTUP_ATTESTATION_WARN_HOURS || 12)) {
    level = 'warn';
    checkReason = 'startup_attestation_verify_stale_warn';
  } else if (failCount > 0 && okCount <= 0) {
    level = 'warn';
    checkReason = 'startup_attestation_recent_failures';
  }

  return {
    name: 'startup_attestation',
    ok: level === 'ok',
    level,
    reason: checkReason,
    metrics: {
      verify_ok: verifyOk,
      verify_reason: reason,
      expires_at: payload && payload.expires_at ? String(payload.expires_at) : null,
      verify_events: Number(telemetry && telemetry.verify_events || 0),
      verify_fail_count: failCount,
      verify_ok_count: Number(telemetry && telemetry.verify_ok_count || 0),
      last_verify_ts: telemetry && telemetry.last_verify_ts ? String(telemetry.last_verify_ts) : null,
      last_verify_age_hours: Number.isFinite(ageHours) ? ageHours : null,
      top_reasons: telemetry && Array.isArray(telemetry.top_reasons) ? telemetry.top_reasons.slice(0, 5) : []
    },
    thresholds: {
      warn_age_hours: Number(STARTUP_ATTESTATION_WARN_HOURS || 12),
      critical_age_hours: Number(STARTUP_ATTESTATION_CRITICAL_HOURS || 36)
    }
  };
}

function assessExecuteQualityLockInvariant(governorStatusResult, strategyReadinessResult) {
  const governorPayload = governorStatusResult && governorStatusResult.payload && typeof governorStatusResult.payload === 'object'
    ? governorStatusResult.payload
    : {};
  const readinessPayload = strategyReadinessResult && strategyReadinessResult.payload && typeof strategyReadinessResult.payload === 'object'
    ? strategyReadinessResult.payload
    : {};
  const readiness = readinessPayload && readinessPayload.readiness && typeof readinessPayload.readiness === 'object'
    ? readinessPayload.readiness
    : {};
  const governorStrategy = governorPayload && governorPayload.strategy && typeof governorPayload.strategy === 'object'
    ? governorPayload.strategy
    : {};
  const governorCanary = governorPayload && governorPayload.canary && typeof governorPayload.canary === 'object'
    ? governorPayload.canary
    : {};
  const governorMetrics = governorCanary && governorCanary.metrics && typeof governorCanary.metrics === 'object'
    ? governorCanary.metrics
    : {};
  const governorPolicy = governorPayload && governorPayload.policy && typeof governorPayload.policy === 'object'
    ? governorPayload.policy
    : {};

  const mode = String(governorStrategy.mode || readiness.current_mode || 'unknown');
  const requireLock = governorMetrics.require_quality_lock_for_execute === true
    || governorPolicy.canary_require_quality_lock_for_execute === true;
  const qualityLockActive = governorMetrics.quality_lock_active === true;
  const stableWindowStreak = Number(governorMetrics.quality_lock_stable_window_streak || 0);
  const transition = governorPayload && governorPayload.transition && typeof governorPayload.transition === 'object'
    ? governorPayload.transition
    : {};
  const demotionPending = mode === 'execute'
    && String(transition.to_mode || '') === 'canary_execute'
    && String(transition.reason || '') === 'quality_lock_inactive_demote_canary';

  let ok = true;
  let level = 'ok';
  let reason = 'execute_quality_lock_invariant_ok';

  if (mode === 'execute') {
    if (!(governorStatusResult && governorStatusResult.ok)) {
      ok = false;
      level = 'critical';
      reason = 'execute_quality_lock_unverifiable';
    } else if (requireLock && !qualityLockActive) {
      ok = false;
      level = demotionPending ? 'warn' : 'critical';
      reason = demotionPending
        ? 'execute_quality_lock_auto_demotion_pending'
        : 'execute_quality_lock_inactive';
    } else if (!requireLock) {
      ok = false;
      level = 'warn';
      reason = 'execute_quality_lock_check_disabled';
    }
  }

  return {
    name: 'execute_quality_lock_invariant',
    ok,
    level,
    reason,
    metrics: {
      mode,
      require_lock: requireLock,
      quality_lock_active: qualityLockActive,
      stable_window_streak: stableWindowStreak,
      demotion_pending: demotionPending,
      transition_to_mode: transition && transition.to_mode ? String(transition.to_mode) : null,
      transition_reason: transition && transition.reason ? String(transition.reason) : null
    },
    thresholds: {
      required_mode: 'execute'
    }
  };
}

function summarizeSlo(checksMap: AnyObj): AnyObj {
  const checks = Object.values(checksMap || {}) as AnyObj[];
  const warns = checks.filter((c) => c && c.level === 'warn');
  const critical = checks.filter((c) => c && c.level === 'critical');
  const failed = checks.filter((c) => c && c.ok !== true);
  const overallLevel = checks.reduce((best, c) => {
    const current = c && typeof c.level === 'string' ? c.level : 'ok';
    return levelRank(current) > levelRank(best) ? current : best;
  }, 'ok');
  return {
    ok: critical.length === 0 && warns.length === 0,
    level: overallLevel,
    check_count: checks.length,
    warn_count: warns.length,
    critical_count: critical.length,
    failed_checks: failed.map((c) => c.name),
    checks: checksMap
  };
}

function makeAlertRows(dateStr: string, windowLabel: string, windowDays: number, slo: AnyObj): AnyObj[] {
  const checks = Object.values(slo && slo.checks ? slo.checks : {}) as AnyObj[];
  const rows = [];
  for (const check of checks) {
    if (!check || check.ok === true) continue;
    const level = check.level === 'critical' ? 'critical' : 'warn';
    const fingerprint = {
      date: dateStr,
      window: windowLabel,
      days: windowDays,
      check: check.name,
      level,
      reason: String(check.reason || ''),
      metrics: check.metrics || {},
      thresholds: check.thresholds || {}
    };
    const alertKey = crypto.createHash('sha1').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 16);
    rows.push({
      ts: nowIso(),
      type: 'autonomy_health_alert',
      date: dateStr,
      window: windowLabel,
      window_days: windowDays,
      check: check.name,
      level,
      summary: String(check.reason || '').slice(0, 200),
      metrics: check.metrics || {},
      thresholds: check.thresholds || {},
      alert_key: alertKey
    });
  }
  return rows;
}

function writeAlerts(dateStr, rows) {
  const fp = path.join(ALERTS_DIR, `${dateStr}.jsonl`);
  ensureDir(path.dirname(fp));
  const existing = readJsonl(fp);
  const seen = new Set(existing.map((r) => String(r && r.alert_key || '')).filter(Boolean));
  let written = 0;
  for (const row of rows) {
    const key = String(row && row.alert_key || '');
    if (!key || seen.has(key)) continue;
    fs.appendFileSync(fp, `${JSON.stringify(row)}\n`, 'utf8');
    seen.add(key);
    written += 1;
  }
  return {
    path: fp,
    generated: rows.length,
    written,
    total: existing.length + written
  };
}

function writeReport(dateStr, windowLabel, out) {
  const fp = path.join(REPORTS_DIR, `${dateStr}.${windowLabel}.json`);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return fp;
}

function reportOperatorTips() {
  return {
    model_catalog: [
      'Autonomy can propose/trial model catalog updates automatically.',
      'Applying routing config changes requires elevated approval.',
      'To include new Ollama cloud models from eyes: set AUTONOMY_MODEL_CATALOG_SOURCE=auto (or eye/local).',
      'Optional auto-apply: set AUTONOMY_MODEL_CATALOG_AUTO_APPLY=1 and AUTONOMY_MODEL_CATALOG_AUTO_APPROVAL_NOTE="...".',
      'Run: CLEARANCE=3 node systems/autonomy/model_catalog_loop.js apply --id=<proposal_id> --approval-note="<reason>"'
    ],
    strategy_mode: [
      'Inspect strategy mode/readiness before enabling execution.',
      'Run: node systems/autonomy/strategy_mode.js status',
      'Run: node systems/autonomy/strategy_mode.js recommend YYYY-MM-DD --days=14',
      'Run: node systems/autonomy/strategy_mode_governor.js status YYYY-MM-DD --days=14',
      'Run: node systems/autonomy/strategy_mode_governor.js run YYYY-MM-DD --days=14',
      'Set mode (manual): node systems/autonomy/strategy_mode.js set --mode=execute --approval-note="<reason>" --approver-id="<id1>" --second-approver-id="<id2>" --second-approval-note="<reason2>"'
    ],
    emergency_stop: [
      'Emergency halt for autonomy/routing/actuation when behavior is unsafe.',
      'Engage: node systems/security/emergency_stop.js engage --scope=all --approval-note="<reason>"',
      'Release: node systems/security/emergency_stop.js release --approval-note="<reason>"'
    ]
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args['help'] || args._[0] === '--help' || args._[0] === '-h' || args._[0] === 'help') {
    usage();
    process.exit(0);
  }

  const dateStr = resolveDateArg(args);
  const windowCfg = resolveWindow(args);
  const writeArtifacts = toBool(args.write, true);
  const alertsEnabled = toBool(args.alerts, true);
  const strict = !!args.strict;
  const dates = dateRange(dateStr, windowCfg.days);
  const now = nowMs();

  const autonomy = runJson(AUTONOMY_CONTROLLER, ['status', dateStr]);
  const receiptSummary = runJson(RECEIPT_SUMMARY, ['run', dateStr, `--days=${Math.max(1, windowCfg.days)}`]);
  const strategyDoctor = runJson(STRATEGY_DOCTOR, ['run']);
  const strategyReadiness = runJson(STRATEGY_READINESS, ['run', dateStr]);
  const strategyModeGovernorState = runStrategyGovernorWithAutoDemotion(dateStr, windowCfg.days);
  const strategyModeGovernor = strategyModeGovernorState.status;
  const architecture = runJson(ARCHITECTURE_GUARD, ['run']);
  const router = runJson(MODEL_ROUTER, ['doctor', '--risk=low', '--complexity=low', '--intent=autonomy_health', '--task=health']);
  const spc = runJson(PIPELINE_SPC_GATE, [
    'run',
    dateStr,
    '--days=1',
    `--baseline-days=${Math.max(3, Number(SPC_BASELINE_DAYS || 21))}`,
    `--sigma=${Number(SPC_SIGMA || 3)}`
  ]);
  const integrity = runJson(INTEGRITY_KERNEL, ['status', `--policy=${INTEGRITY_POLICY}`]);
  const startupAttestationState = verifyStartupAttestationWithAutoIssue();
  const startupAttestation = startupAttestationState.verify;

  const routingHealth = routingHealthCacheSummary();
  const routingDoctorRuntime = routingDoctorRuntimeSummary(router.payload || null);
  const routingRecovery = routingRecoveryPulseSummary(dates, now);
  const startupAttestationTelemetry = startupAttestationTelemetrySummary(dates, now);
  const spineHealth = readJson(SPINE_HEALTH_PATH, { consecutive_full_local_down: 0, last_preflight: null });
  const cooldowns = readJson(AUTONOMY_COOLDOWNS, {});
  const actuation = actuationReceiptSummary(dateStr);
  const registry = readJson(EYES_REGISTRY_PATH, { eyes: [] });
  const eyesCatalog = readJson(EYES_CATALOG_PATH, { eyes: [] });
  const eyeMetaMap = buildEyeRuntimeMeta(eyesCatalog, registry);
  const proposalRows = readProposalRows(dates);
  const queueEvents = readQueueEvents(dates);
  const runEvents = readAutonomyRunEvents(dates);
  const autonomyEnabled = !!(autonomy.payload && autonomy.payload.autonomy_enabled === true);

  const routing = {
    spine_local_down_consecutive: Number(spineHealth.consecutive_full_local_down || 0),
    spine_last_preflight: spineHealth.last_preflight || null,
    doctor_ok: router.ok,
    doctor_summary: router.payload && router.payload.tier1_local_decision ? router.payload.tier1_local_decision : null,
    doctor_runtime: routingDoctorRuntime,
    recovery_pulse: routingRecovery,
    health_cache: routingHealth
  };

  const checks = {
    dark_eyes: assessDarkEyes(now, registry, eyeMetaMap),
    dream_degradation: assessDreamDegradation(now, dates, autonomyEnabled),
    queue_backlog: assessQueueBacklog(
      now,
      proposalRows,
      queueEvents,
      windowCfg.days,
      autonomyEnabled
    ),
    proposal_starvation: assessProposalStarvation(
      now,
      proposalRows,
      queueEvents,
      runEvents,
      autonomyEnabled
    ),
    loop_stall: assessLoopStall(now, runEvents, autonomyEnabled),
    drift: assessDrift(spc, autonomyEnabled),
    routing_degraded: assessRoutingDegraded(routing),
    routing_recovery_pulse: assessRoutingRecoveryPulse(routing, autonomyEnabled),
    budget_guard: assessBudgetGuard(now, dates),
    route_attestation: assessRouteAttestation(receiptSummary),
    startup_attestation: assessStartupAttestation(startupAttestation, startupAttestationTelemetry),
    criteria_quality_gate: assessCriteriaQualityGate(strategyReadiness, receiptSummary),
    execute_quality_lock_invariant: assessExecuteQualityLockInvariant(strategyModeGovernor, strategyReadiness),
    integrity: assessIntegrity(integrity)
  };
  const slo = summarizeSlo(checks);

  const out = {
    ok: true,
    ts: nowIso(),
    date: dateStr,
    window: windowCfg.label,
    window_days: windowCfg.days,
    date_range: { start: dates[0] || dateStr, end: dateStr },
    operator_tips: reportOperatorTips(),
    routing,
    emergency_stop: getStopState(),
    autonomy: autonomy.payload || { ok: false, error: autonomy.stderr || `status_exit_${autonomy.code}` },
    strategy: strategyDoctor.payload || { ok: false, error: strategyDoctor.stderr || `strategy_doctor_exit_${strategyDoctor.code}` },
    strategy_readiness: strategyReadiness.payload || { ok: false, error: strategyReadiness.stderr || `strategy_readiness_exit_${strategyReadiness.code}` },
    strategy_mode_governor: strategyModeGovernor.payload || {
      ok: false,
      error: strategyModeGovernor.stderr || `strategy_mode_governor_exit_${strategyModeGovernor.code}`
    },
    strategy_mode_governor_auto_demotion: strategyModeGovernorState.auto_demotion,
    startup_attestation: startupAttestation.payload || {
      ok: false,
      error: startupAttestation.stderr || `startup_attestation_exit_${startupAttestation.code}`
    },
    startup_attestation_auto_issue: startupAttestationState.auto_issue,
    startup_attestation_telemetry: startupAttestationTelemetry,
    autonomy_receipts: receiptSummary.payload || { ok: false, error: receiptSummary.stderr || `receipt_summary_exit_${receiptSummary.code}` },
    architecture_guard: architecture.payload || { ok: false, error: architecture.stderr || `architecture_guard_exit_${architecture.code}` },
    pipeline_spc: spc.payload || { ok: false, error: spc.stderr || `pipeline_spc_exit_${spc.code}` },
    integrity_kernel: integrity.payload || { ok: false, error: integrity.stderr || `integrity_kernel_exit_${integrity.code}` },
    actuation,
    gates: {
      cooldown_count: Object.keys(cooldowns || {}).length,
      budget_autopause_active: checks.budget_guard && checks.budget_guard.metrics
        ? checks.budget_guard.metrics.autopause_active === true
        : false
    },
    observed: {
      proposal_rows: proposalRows.length,
      queue_events: queueEvents.length,
      autonomy_runs: runEvents.length,
      eyes_total: Array.isArray(registry && registry.eyes) ? registry.eyes.length : 0
    },
    slo,
    alerts: {
      enabled: alertsEnabled,
      generated: 0,
      written: 0,
      total: 0,
      path: null
    },
    report: {
      written: false,
      path: null
    }
  };

  if (alertsEnabled) {
    const alertRows = makeAlertRows(dateStr, windowCfg.label, windowCfg.days, slo);
    const alertWrite = writeAlerts(dateStr, alertRows);
    out.alerts.generated = alertWrite.generated;
    out.alerts.written = alertWrite.written;
    out.alerts.total = alertWrite.total;
    out.alerts.path = alertWrite.path;
  }

  if (writeArtifacts) {
    const reportPath = writeReport(dateStr, windowCfg.label, out);
    out.report.written = true;
    out.report.path = reportPath;
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && Number(slo.critical_count || 0) > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  resolveWindow,
  summarizeSlo,
  assessDarkEyes,
  assessProposalStarvation,
  assessLoopStall,
  assessDrift,
  assessDreamDegradation,
  assessRoutingDegraded,
  assessBudgetGuard,
  assessRouteAttestation,
  assessCriteriaQualityGate,
  assessExecuteQualityLockInvariant,
  assessIntegrity,
  makeAlertRows
};

#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getStopState } = require('../../lib/emergency_stop.js');

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
const AUTONOMY_COOLDOWNS = process.env.AUTONOMY_HEALTH_COOLDOWNS_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_COOLDOWNS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'cooldowns.json');
const EYES_REGISTRY_PATH = process.env.AUTONOMY_HEALTH_EYES_REGISTRY_PATH
  ? path.resolve(process.env.AUTONOMY_HEALTH_EYES_REGISTRY_PATH)
  : path.join(ROOT, 'state', 'sensory', 'eyes', 'registry.json');
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

const LOOP_STALL_WARN_HOURS = Number(process.env.AUTONOMY_HEALTH_LOOP_STALL_WARN_HOURS || 8);
const LOOP_STALL_CRITICAL_HOURS = Number(process.env.AUTONOMY_HEALTH_LOOP_STALL_CRITICAL_HOURS || 24);

const ROUTING_DOWN_WARN = Number(process.env.AUTONOMY_HEALTH_ROUTING_DOWN_WARN || 1);
const ROUTING_DOWN_CRITICAL = Number(process.env.AUTONOMY_HEALTH_ROUTING_DOWN_CRITICAL || 3);

const SPC_BASELINE_DAYS = Number(process.env.AUTONOMY_HEALTH_SPC_BASELINE_DAYS || 21);
const SPC_SIGMA = Number(process.env.AUTONOMY_HEALTH_SPC_SIGMA || 3);

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

function parseArgs(argv) {
  const out = { _: [] };
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

function readJson(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
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
  if (!Number.isFinite(Number(ts))) return null;
  return Number(((Number(now) - Number(ts)) / 3600000).toFixed(3));
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
  const byRuntimeCounts = {};
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

function levelRank(level) {
  if (level === 'critical') return 3;
  if (level === 'warn') return 2;
  if (level === 'unknown') return 1;
  return 0;
}

function assessDarkEyes(now, registry) {
  const eyes = registry && Array.isArray(registry.eyes) ? registry.eyes : [];
  const dark = [];
  for (const eye of eyes) {
    const id = String(eye && eye.id || '');
    if (!id) continue;
    const status = String(eye && eye.status || '').toLowerCase();
    const lastSuccessMs = toMs(eye && (eye.last_success || eye.last_run || eye.last_real_signal_ts || null));
    const ageHours = hoursSince(lastSuccessMs, now);
    const consecutiveFailures = Number(eye && eye.consecutive_failures || 0);
    const stale = ageHours != null && ageHours >= Number(DARK_EYE_MAX_IDLE_HOURS || 12);
    const failing = consecutiveFailures >= Number(DARK_EYE_FAIL_COUNT || 2) || status === 'failing';
    if (stale || failing) {
      dark.push({
        id,
        status,
        age_hours: ageHours,
        consecutive_failures: consecutiveFailures,
        stale,
        failing
      });
    }
  }
  const total = eyes.length;
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
      fail_count: Number(DARK_EYE_FAIL_COUNT || 2),
      critical_count: criticalThreshold
    },
    details: dark.slice(0, 20)
  };
}

function assessProposalStarvation(now, proposalRows, queueEvents, runEvents) {
  const eligible = proposalRows.filter((row) => {
    const p = row && row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
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
  const warn = eligibleCount >= Number(STARVATION_MIN_ELIGIBLE || 3)
    && (ageHours == null || ageHours >= Number(STARVATION_WARN_HOURS || 18));
  const critical = eligibleCount >= Number(STARVATION_CRITICAL_ELIGIBLE || 6)
    && (ageHours == null || ageHours >= Number(STARVATION_CRITICAL_HOURS || 36));
  const level = critical ? 'critical' : (warn ? 'warn' : 'ok');
  return {
    name: 'proposal_starvation',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'eligible_proposals_have_recent_progress'
      : `eligible=${eligibleCount} age_hours=${ageHours == null ? 'none' : ageHours}`,
    metrics: {
      eligible_count: eligibleCount,
      queue_accept_count: acceptedEvents.length,
      queue_outcome_count: outcomeEvents.length,
      run_executed_count: runEvents.filter((e) => String(e.result || '') === 'executed').length,
      last_progress_ts: lastProgress ? new Date(lastProgress).toISOString() : null,
      hours_since_progress: ageHours
    },
    thresholds: {
      min_eligible: Number(STARVATION_MIN_ELIGIBLE || 3),
      warn_hours: Number(STARVATION_WARN_HOURS || 18),
      critical_hours: Number(STARVATION_CRITICAL_HOURS || 36),
      critical_eligible: Number(STARVATION_CRITICAL_ELIGIBLE || 6)
    }
  };
}

function assessLoopStall(now, runEvents) {
  const lastRun = lastTs(runEvents, () => true);
  const ageHours = hoursSince(lastRun, now);
  const runs24h = runEvents.filter((e) => {
    const t = toMs(e && e.ts);
    return Number.isFinite(t) && (now - t) <= 24 * 3600 * 1000;
  }).length;
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

function assessDrift(spcResult) {
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
  const level = failed.length >= 2 ? 'critical' : (failed.length > 0 ? 'warn' : 'ok');
  return {
    name: 'drift',
    ok: level === 'ok',
    level,
    reason: level === 'ok' ? 'spc_in_control' : `spc_failed=${failed.join(',')}`,
    metrics: {
      spc_ok: true,
      hold_escalation: payload.hold_escalation === true,
      failed_checks: failed
    },
    thresholds: {
      baseline_days: payload.control ? Number(payload.control.baseline_days || SPC_BASELINE_DAYS) : Number(SPC_BASELINE_DAYS || 21),
      sigma: payload.control ? Number(payload.control.sigma || SPC_SIGMA) : Number(SPC_SIGMA || 3)
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
  let level = 'ok';
  if (downConsecutive >= Number(ROUTING_DOWN_CRITICAL || 3)) {
    level = 'critical';
  } else if (
    downConsecutive >= Number(ROUTING_DOWN_WARN || 1)
    || doctor.escalate === true
    || Number(runtime.local_eligible_models || 0) <= 0
  ) {
    level = 'warn';
  }
  return {
    name: 'routing_degraded',
    ok: level === 'ok',
    level,
    reason: level === 'ok'
      ? 'local_routing_healthy'
      : `down_consecutive=${downConsecutive} escalate=${doctor.escalate === true}`,
    metrics: {
      spine_local_down_consecutive: downConsecutive,
      doctor_escalate: doctor.escalate === true,
      doctor_reason: doctor.reason || null,
      local_total_models: Number(runtime.total_local_models || 0),
      local_eligible_models: Number(runtime.local_eligible_models || 0),
      stale_local_records: Number(runtime.stale_local_records || 0)
    },
    thresholds: {
      warn_down_consecutive: Number(ROUTING_DOWN_WARN || 1),
      critical_down_consecutive: Number(ROUTING_DOWN_CRITICAL || 3),
      min_local_eligible_models: 1
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

  let ok = true;
  let level = 'ok';
  let reason = 'criteria_quality_gate_ok';
  if (insufficientFail || insufficientRate > maxInsufficientRate) {
    ok = false;
    level = 'critical';
    reason = 'criteria_quality_insufficient_rate_high';
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
      level = 'critical';
      reason = 'execute_quality_lock_inactive';
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
      stable_window_streak: stableWindowStreak
    },
    thresholds: {
      required_mode: 'execute'
    }
  };
}

function summarizeSlo(checksMap) {
  const checks = Object.values(checksMap || {});
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

function makeAlertRows(dateStr, windowLabel, windowDays, slo) {
  const checks = Object.values(slo && slo.checks ? slo.checks : {});
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
  const strategyModeGovernor = runJson(STRATEGY_MODE_GOVERNOR, ['status', dateStr, `--days=${Math.max(1, windowCfg.days)}`]);
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

  const routingHealth = routingHealthCacheSummary();
  const routingDoctorRuntime = routingDoctorRuntimeSummary(router.payload || null);
  const spineHealth = readJson(SPINE_HEALTH_PATH, { consecutive_full_local_down: 0, last_preflight: null });
  const cooldowns = readJson(AUTONOMY_COOLDOWNS, {});
  const actuation = actuationReceiptSummary(dateStr);
  const registry = readJson(EYES_REGISTRY_PATH, { eyes: [] });
  const proposalRows = readProposalRows(dates);
  const queueEvents = readQueueEvents(dates);
  const runEvents = readAutonomyRunEvents(dates);

  const routing = {
    spine_local_down_consecutive: Number(spineHealth.consecutive_full_local_down || 0),
    spine_last_preflight: spineHealth.last_preflight || null,
    doctor_ok: router.ok,
    doctor_summary: router.payload && router.payload.tier1_local_decision ? router.payload.tier1_local_decision : null,
    doctor_runtime: routingDoctorRuntime,
    health_cache: routingHealth
  };

  const checks = {
    dark_eyes: assessDarkEyes(now, registry),
    proposal_starvation: assessProposalStarvation(now, proposalRows, queueEvents, runEvents),
    loop_stall: assessLoopStall(now, runEvents),
    drift: assessDrift(spc),
    routing_degraded: assessRoutingDegraded(routing),
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
    autonomy_receipts: receiptSummary.payload || { ok: false, error: receiptSummary.stderr || `receipt_summary_exit_${receiptSummary.code}` },
    architecture_guard: architecture.payload || { ok: false, error: architecture.stderr || `architecture_guard_exit_${architecture.code}` },
    pipeline_spc: spc.payload || { ok: false, error: spc.stderr || `pipeline_spc_exit_${spc.code}` },
    integrity_kernel: integrity.payload || { ok: false, error: integrity.stderr || `integrity_kernel_exit_${integrity.code}` },
    actuation,
    gates: {
      cooldown_count: Object.keys(cooldowns || {}).length
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
  assessRoutingDegraded,
  assessCriteriaQualityGate,
  assessExecuteQualityLockInvariant,
  assessIntegrity,
  makeAlertRows
};

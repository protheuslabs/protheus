#!/usr/bin/env node
'use strict';
export {};

/**
 * RM-119: execution reliability parity SLO closure tracker.
 *
 * Tracks a rolling live-run window and evaluates:
 * - execution success rate
 * - queue drain rate
 * - p95 time-to-first-execution
 * - zero-shipped day streak
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EXECUTION_RELIABILITY_SLO_POLICY_PATH
  ? path.resolve(process.env.EXECUTION_RELIABILITY_SLO_POLICY_PATH)
  : path.join(ROOT, 'config', 'execution_reliability_slo_policy.json');
const DEFAULT_STATE_PATH = process.env.EXECUTION_RELIABILITY_SLO_STATE_PATH
  ? path.resolve(process.env.EXECUTION_RELIABILITY_SLO_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'execution_reliability_slo.json');
const DEFAULT_HISTORY_PATH = process.env.EXECUTION_RELIABILITY_SLO_HISTORY_PATH
  ? path.resolve(process.env.EXECUTION_RELIABILITY_SLO_HISTORY_PATH)
  : path.join(ROOT, 'state', 'ops', 'execution_reliability_slo_history.jsonl');
const DEFAULT_EXECUTOR_HISTORY_PATH = process.env.EXECUTION_RELIABILITY_EXECUTOR_HISTORY_PATH
  ? path.resolve(process.env.EXECUTION_RELIABILITY_EXECUTOR_HISTORY_PATH)
  : path.join(ROOT, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function toDate(raw: unknown) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayUtc();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok).startsWith('--')) {
      out._.push(String(tok));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx === -1) {
      out[String(tok).slice(2)] = true;
      continue;
    }
    out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
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

function safeRate(num: unknown, den: unknown, fallback = 0) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return fallback;
  return n / d;
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    const lines = String(fs.readFileSync(filePath, 'utf8') || '').split('\n');
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // ignore malformed rows
      }
    }
    return out;
  } catch {
    return [];
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function addUtcDays(dateStr: string, deltaDays: number) {
  const ts = Date.parse(`${String(dateStr)}T00:00:00.000Z`);
  if (!Number.isFinite(ts)) return todayUtc();
  return new Date(ts + (deltaDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function dateDistanceDaysUtc(olderDate: string, newerDate: string) {
  const t0 = Date.parse(`${String(olderDate)}T00:00:00.000Z`);
  const t1 = Date.parse(`${String(newerDate)}T00:00:00.000Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
}

function quantile(values: number[], q: number) {
  const arr = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const qq = clampNumber(q, 0, 1, 0.95);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(qq * arr.length) - 1));
  return arr[idx];
}

function defaultPolicy() {
  return {
    version: '1.0',
    window_days: 30,
    min_live_runs: 10,
    min_execution_success_rate: 0.97,
    min_queue_drain_rate: 0.9,
    max_time_to_first_execution_p95_ms: 120000,
    max_zero_shipped_streak_days: 6,
    max_history_rows: 400
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: String(raw && raw.version || base.version),
    window_days: clampInt(raw && raw.window_days, 7, 120, base.window_days),
    min_live_runs: clampInt(raw && raw.min_live_runs, 1, 1000, base.min_live_runs),
    min_execution_success_rate: clampNumber(
      raw && raw.min_execution_success_rate,
      0,
      1,
      base.min_execution_success_rate
    ),
    min_queue_drain_rate: clampNumber(
      raw && raw.min_queue_drain_rate,
      0,
      1,
      base.min_queue_drain_rate
    ),
    max_time_to_first_execution_p95_ms: clampInt(
      raw && raw.max_time_to_first_execution_p95_ms,
      1000,
      24 * 60 * 60 * 1000,
      base.max_time_to_first_execution_p95_ms
    ),
    max_zero_shipped_streak_days: clampInt(
      raw && raw.max_zero_shipped_streak_days,
      0,
      120,
      base.max_zero_shipped_streak_days
    ),
    max_history_rows: clampInt(raw && raw.max_history_rows, 50, 5000, base.max_history_rows)
  };
}

function trimHistory(historyPath: string, maxRows: number) {
  if (!fs.existsSync(historyPath)) return;
  const lines = String(fs.readFileSync(historyPath, 'utf8') || '')
    .split('\n')
    .filter(Boolean);
  if (lines.length <= maxRows) return;
  fs.writeFileSync(historyPath, `${lines.slice(lines.length - maxRows).join('\n')}\n`, 'utf8');
}

function computeZeroShippedStreak(dayAgg: Map<string, AnyObj>, endDate: string, windowDays: number) {
  let streak = 0;
  for (let i = 0; i < windowDays; i += 1) {
    const day = addUtcDays(endDate, -i);
    const row = dayAgg.get(day);
    const succeeded = Number(row && row.workflows_succeeded || 0);
    if (succeeded > 0) break;
    streak += 1;
  }
  return streak;
}

function runSlo(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args._[1] || args.date);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : DEFAULT_STATE_PATH;
  const historyPath = args['history-path'] ? path.resolve(String(args['history-path'])) : DEFAULT_HISTORY_PATH;
  const executorHistoryPath = args['executor-history-path']
    ? path.resolve(String(args['executor-history-path']))
    : DEFAULT_EXECUTOR_HISTORY_PATH;
  const strict = toBool(args.strict, false);

  const windowDays = clampInt(args['window-days'] ?? args.window_days, 7, 120, policy.window_days);
  const minLiveRuns = clampInt(args['min-live-runs'] ?? args.min_live_runs, 1, 1000, policy.min_live_runs);
  const minExecutionSuccessRate = clampNumber(
    args['min-success-rate'] ?? args.min_execution_success_rate,
    0,
    1,
    policy.min_execution_success_rate
  );
  const minQueueDrainRate = clampNumber(
    args['min-queue-drain'] ?? args.min_queue_drain_rate,
    0,
    1,
    policy.min_queue_drain_rate
  );
  const maxTtfP95Ms = clampInt(
    args['max-ttf-p95-ms'] ?? args.max_time_to_first_execution_p95_ms,
    1000,
    24 * 60 * 60 * 1000,
    policy.max_time_to_first_execution_p95_ms
  );
  const maxZeroShippedStreakDays = clampInt(
    args['max-zero-shipped-streak-days'] ?? args.max_zero_shipped_streak_days,
    0,
    120,
    policy.max_zero_shipped_streak_days
  );

  const rawHistory = readJsonl(executorHistoryPath).filter((row: AnyObj) => row && typeof row === 'object');
  const startDate = addUtcDays(date, -(windowDays - 1));
  const windowRows = rawHistory.filter((row: AnyObj) => {
    if (row.dry_run === true) return false;
    const d = toDate(row.date);
    if (dateDistanceDaysUtc(startDate, d) == null) return false;
    const fromStart = dateDistanceDaysUtc(startDate, d);
    const toEnd = dateDistanceDaysUtc(d, date);
    return fromStart != null && toEnd != null && fromStart >= 0 && toEnd >= 0;
  });

  const totals = {
    workflows_selected: 0,
    workflows_executed: 0,
    workflows_succeeded: 0,
    workflows_failed: 0,
    workflows_blocked: 0
  };
  const ttfValues: number[] = [];
  const dayAgg = new Map<string, AnyObj>();

  for (const row of windowRows) {
    const selected = Math.max(0, Number(row.workflows_selected || 0));
    const executed = Math.max(0, Number(row.workflows_executed || 0));
    const succeeded = Math.max(0, Number(row.workflows_succeeded || 0));
    const failed = Math.max(0, Number(row.workflows_failed || 0));
    const blocked = Math.max(0, Number(row.workflows_blocked || 0));
    totals.workflows_selected += selected;
    totals.workflows_executed += executed;
    totals.workflows_succeeded += succeeded;
    totals.workflows_failed += failed;
    totals.workflows_blocked += blocked;

    const ttf = Number(row.time_to_first_execution_ms);
    if (Number.isFinite(ttf) && ttf >= 0) ttfValues.push(ttf);

    const d = toDate(row.date);
    const prev = dayAgg.get(d) || {
      date: d,
      runs: 0,
      workflows_selected: 0,
      workflows_executed: 0,
      workflows_succeeded: 0
    };
    prev.runs += 1;
    prev.workflows_selected += selected;
    prev.workflows_executed += executed;
    prev.workflows_succeeded += succeeded;
    dayAgg.set(d, prev);
  }

  const executionSuccessRate = safeRate(totals.workflows_succeeded, totals.workflows_executed, 0);
  const queueDrainRate = safeRate(totals.workflows_executed, totals.workflows_selected, 0);
  const ttfP95 = quantile(ttfValues, 0.95);
  const zeroShippedStreakDays = computeZeroShippedStreak(dayAgg, date, windowDays);
  const liveRuns = windowRows.length;
  const sufficientData = liveRuns >= minLiveRuns;

  const checks = {
    sufficient_data: sufficientData,
    execution_success_rate: executionSuccessRate >= minExecutionSuccessRate,
    queue_drain_rate: queueDrainRate >= minQueueDrainRate,
    time_to_first_execution_p95_ms: ttfP95 != null && ttfP95 <= maxTtfP95Ms,
    zero_shipped_streak_days: zeroShippedStreakDays <= maxZeroShippedStreakDays
  };
  const blockingChecks = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([key]) => key);
  const recoveryGaps = {
    execution_success_rate: Number(Math.max(0, minExecutionSuccessRate - executionSuccessRate).toFixed(6)),
    queue_drain_rate: Number(Math.max(0, minQueueDrainRate - queueDrainRate).toFixed(6)),
    time_to_first_execution_p95_ms: Number(
      Math.max(0, Number(ttfP95 == null ? 0 : ttfP95) - maxTtfP95Ms)
    ),
    zero_shipped_streak_days: Number(Math.max(0, zeroShippedStreakDays - maxZeroShippedStreakDays))
  };
  const remainingRecoveryDays = Number(recoveryGaps.zero_shipped_streak_days || 0);
  const projectedRecoveryDate = remainingRecoveryDays > 0
    ? addUtcDays(date, remainingRecoveryDays)
    : date;
  const pass = checks.sufficient_data
    && checks.execution_success_rate
    && checks.queue_drain_rate
    && checks.time_to_first_execution_p95_ms
    && checks.zero_shipped_streak_days;

  const payload = {
    ok: true,
    type: 'execution_reliability_slo',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    window_days: windowDays,
    window_start: startDate,
    live_runs: liveRuns,
    thresholds: {
      min_live_runs: minLiveRuns,
      min_execution_success_rate: Number(minExecutionSuccessRate.toFixed(4)),
      min_queue_drain_rate: Number(minQueueDrainRate.toFixed(4)),
      max_time_to_first_execution_p95_ms: maxTtfP95Ms,
      max_zero_shipped_streak_days: maxZeroShippedStreakDays
    },
    measured: {
      execution_success_rate: Number(executionSuccessRate.toFixed(4)),
      queue_drain_rate: Number(queueDrainRate.toFixed(4)),
      time_to_first_execution_p95_ms: ttfP95 == null ? null : Number(ttfP95),
      zero_shipped_streak_days: zeroShippedStreakDays
    },
    blocking_checks: blockingChecks,
    recovery_gaps: recoveryGaps,
    remaining_recovery_days: remainingRecoveryDays,
    projected_recovery_date: projectedRecoveryDate,
    totals,
    checks,
    pass,
    result: pass ? 'pass' : (sufficientData ? 'fail' : 'insufficient_data'),
    sample_days: Array.from(dayAgg.values())
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 10),
    executor_history_path: relPath(executorHistoryPath),
    state_path: relPath(statePath),
    history_path: relPath(historyPath)
  };

  writeJsonAtomic(statePath, {
    schema_id: 'execution_reliability_slo',
    schema_version: '1.0',
    updated_at: payload.ts,
    date: payload.date,
    policy_version: payload.policy_version,
    window_days: payload.window_days,
    window_start: payload.window_start,
    live_runs: payload.live_runs,
    thresholds: payload.thresholds,
    measured: payload.measured,
    blocking_checks: payload.blocking_checks,
    recovery_gaps: payload.recovery_gaps,
    remaining_recovery_days: payload.remaining_recovery_days,
    projected_recovery_date: payload.projected_recovery_date,
    checks: payload.checks,
    pass: payload.pass === true,
    result: payload.result
  });
  appendJsonl(historyPath, {
    ts: payload.ts,
    date: payload.date,
    window_days: payload.window_days,
    live_runs: payload.live_runs,
    measured: payload.measured,
    blocking_checks: payload.blocking_checks,
    remaining_recovery_days: payload.remaining_recovery_days,
    projected_recovery_date: payload.projected_recovery_date,
    checks: payload.checks,
    pass: payload.pass === true,
    result: payload.result
  });
  trimHistory(historyPath, policy.max_history_rows);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !pass) process.exit(1);
}

function statusSlo() {
  const payload = readJson(DEFAULT_STATE_PATH, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'execution_reliability_slo_status',
    ts: nowIso(),
    available: !!payload,
    state_path: relPath(DEFAULT_STATE_PATH),
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/execution_reliability_slo.js run [YYYY-MM-DD] [--window-days=30] [--strict=1]');
  console.log('  node systems/ops/execution_reliability_slo.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === 'run') {
    runSlo(args);
    return;
  }
  if (cmd === 'status' || cmd === 'latest') {
    statusSlo();
    return;
  }
  usage();
  process.exit(2);
}

main();

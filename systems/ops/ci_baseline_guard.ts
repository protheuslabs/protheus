#!/usr/bin/env node
'use strict';
export {};

/**
 * RM-001 support guard:
 * - Validates CI baseline streak freshness.
 * - Tracks progress to 7-day consecutive green target.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CI_BASELINE_GUARD_POLICY_PATH
  ? path.resolve(process.env.CI_BASELINE_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'ci_baseline_guard_policy.json');
const DEFAULT_CI_STREAK_STATE_PATH = process.env.CI_BASELINE_STREAK_STATE_PATH
  ? path.resolve(process.env.CI_BASELINE_STREAK_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'ci_baseline_streak.json');
const DEFAULT_STATE_PATH = process.env.CI_BASELINE_GUARD_STATE_PATH
  ? path.resolve(process.env.CI_BASELINE_GUARD_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'ci_baseline_guard.json');
const DEFAULT_HISTORY_PATH = process.env.CI_BASELINE_GUARD_HISTORY_PATH
  ? path.resolve(process.env.CI_BASELINE_GUARD_HISTORY_PATH)
  : path.join(ROOT, 'state', 'ops', 'ci_baseline_guard_history.jsonl');

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

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
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

function trimHistory(historyPath: string, maxRows: number) {
  if (!fs.existsSync(historyPath)) return;
  const lines = String(fs.readFileSync(historyPath, 'utf8') || '')
    .split('\n')
    .filter(Boolean);
  if (lines.length <= maxRows) return;
  fs.writeFileSync(historyPath, `${lines.slice(lines.length - maxRows).join('\n')}\n`, 'utf8');
}

function countSameDayGreenRuns(historyRows: unknown[], day: string) {
  if (!Array.isArray(historyRows) || !day) return 0;
  return historyRows.filter((row: AnyObj) => {
    if (!row || typeof row !== 'object') return false;
    const d = toDate(row.date);
    return d === day && row.ok === true;
  }).length;
}

function countUniqueGreenDays(historyRows: unknown[]) {
  if (!Array.isArray(historyRows)) return 0;
  const days = new Set<string>();
  for (const row of historyRows as AnyObj[]) {
    if (!row || typeof row !== 'object' || row.ok !== true) continue;
    const d = toDate(row.date);
    if (!d) continue;
    days.add(d);
  }
  return days.size;
}

function defaultPolicy() {
  return {
    version: '1.0',
    target_days: 7,
    stale_after_days: 1,
    max_history_rows: 240
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: String(raw && raw.version || base.version),
    target_days: clampInt(raw && raw.target_days, 1, 60, base.target_days),
    stale_after_days: clampInt(raw && raw.stale_after_days, 0, 30, base.stale_after_days),
    max_history_rows: clampInt(raw && raw.max_history_rows, 20, 5000, base.max_history_rows)
  };
}

function runGuard(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = toDate(args._[1] || args.date);
  const statePath = args['state-path'] ? path.resolve(String(args['state-path'])) : DEFAULT_STATE_PATH;
  const historyPath = args['history-path'] ? path.resolve(String(args['history-path'])) : DEFAULT_HISTORY_PATH;
  const ciStatePath = args['ci-state-path'] ? path.resolve(String(args['ci-state-path'])) : DEFAULT_CI_STREAK_STATE_PATH;
  const strict = toBool(args.strict, false);

  const targetDays = clampInt(args['target-days'] ?? args.target_days, 1, 60, policy.target_days);
  const staleAfterDays = clampInt(args['stale-after-days'] ?? args.stale_after_days, 0, 30, policy.stale_after_days);
  const ciState = readJson(ciStatePath, null);

  const available = !!(ciState && typeof ciState === 'object');
  const streak = available ? Math.max(0, Number(ciState.consecutive_daily_green_runs || 0)) : 0;
  const latestGreenDate = available ? String(ciState.latest_green_date || '').trim() : '';
  const latestRow = available && Array.isArray(ciState.history) && ciState.history.length > 0
    ? ciState.history[ciState.history.length - 1]
    : null;
  const latestRunDate = latestRow ? String(latestRow.date || '').trim() : '';
  const latestRunOk = latestRow ? latestRow.ok === true : null;
  const latestLagDaysRaw = latestRunDate ? dateDistanceDaysUtc(latestRunDate, date) : null;
  const latestLagDays = latestLagDaysRaw == null ? null : Math.max(0, latestLagDaysRaw);
  const stale = latestLagDays == null ? true : latestLagDays > staleAfterDays;
  const sameDayGreenRuns = countSameDayGreenRuns(ciState && ciState.history, date);
  const uniqueGreenDays = countUniqueGreenDays(ciState && ciState.history);

  const checks = {
    state_available: available,
    latest_run_fresh: !stale,
    latest_run_green: latestRunOk === true,
    streak_target_met: streak >= targetDays
  };
  const blockingChecks = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([key]) => key);
  const remainingDays = Math.max(0, targetDays - streak);
  const targetEtaDate = checks.latest_run_fresh && checks.latest_run_green
    ? addUtcDays(date, remainingDays)
    : null;
  const advisories = {
    requires_future_green_days: remainingDays > 0,
    same_day_streak_progress_only: remainingDays > 0 && sameDayGreenRuns > 0 && latestRunDate === date
  };

  const pass = checks.state_available
    && checks.latest_run_fresh
    && checks.latest_run_green
    && checks.streak_target_met;
  const result = pass
    ? 'pass'
    : (!checks.state_available ? 'missing_state' : (checks.latest_run_fresh ? 'pending' : 'stale'));

  const payload = {
    ok: true,
    type: 'ci_baseline_guard',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    target_days: targetDays,
    stale_after_days: staleAfterDays,
    streak,
    same_day_green_runs: sameDayGreenRuns,
    unique_green_days_observed: uniqueGreenDays,
    remaining_days: remainingDays,
    target_eta_date: targetEtaDate,
    advisories,
    latest_green_date: latestGreenDate || null,
    latest_run_date: latestRunDate || null,
    latest_run_ok: latestRunOk,
    latest_run_lag_days: latestLagDays,
    checks,
    blocking_checks: blockingChecks,
    pass,
    result,
    ci_state_path: relPath(ciStatePath),
    state_path: relPath(statePath),
    history_path: relPath(historyPath)
  };

  writeJsonAtomic(statePath, {
    schema_id: 'ci_baseline_guard',
    schema_version: '1.0',
    updated_at: payload.ts,
    date: payload.date,
    policy_version: payload.policy_version,
    target_days: payload.target_days,
    stale_after_days: payload.stale_after_days,
    streak: payload.streak,
    same_day_green_runs: payload.same_day_green_runs,
    unique_green_days_observed: payload.unique_green_days_observed,
    remaining_days: payload.remaining_days,
    target_eta_date: payload.target_eta_date,
    advisories: payload.advisories,
    latest_green_date: payload.latest_green_date,
    latest_run_date: payload.latest_run_date,
    latest_run_ok: payload.latest_run_ok,
    latest_run_lag_days: payload.latest_run_lag_days,
    checks: payload.checks,
    blocking_checks: payload.blocking_checks,
    pass: payload.pass === true,
    result: payload.result
  });
  appendJsonl(historyPath, {
    ts: payload.ts,
    date: payload.date,
    streak: payload.streak,
    same_day_green_runs: payload.same_day_green_runs,
    unique_green_days_observed: payload.unique_green_days_observed,
    remaining_days: payload.remaining_days,
    target_eta_date: payload.target_eta_date,
    advisories: payload.advisories,
    checks: payload.checks,
    blocking_checks: payload.blocking_checks,
    pass: payload.pass === true,
    result: payload.result
  });
  trimHistory(historyPath, policy.max_history_rows);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && !pass) process.exit(1);
}

function statusGuard() {
  const payload = readJson(DEFAULT_STATE_PATH, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'ci_baseline_guard_status',
    ts: nowIso(),
    available: !!payload,
    state_path: relPath(DEFAULT_STATE_PATH),
    payload: payload && typeof payload === 'object' ? payload : null
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ci_baseline_guard.js run [YYYY-MM-DD] [--target-days=7] [--strict=1]');
  console.log('  node systems/ops/ci_baseline_guard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (cmd === 'run') {
    runGuard(args);
    return;
  }
  if (cmd === 'status' || cmd === 'latest') {
    statusGuard();
    return;
  }
  usage();
  process.exit(2);
}

main();

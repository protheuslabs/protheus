#!/usr/bin/env node
'use strict';
export {};

/**
 * execution_doctor_ga.js
 *
 * Reliability gate for execution + doctor closure (V2-054).
 *
 * Usage:
 *   node systems/ops/execution_doctor_ga.js run [--policy=path] [--date=YYYY-MM-DD] [--strict=1]
 *   node systems/ops/execution_doctor_ga.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EXECUTION_DOCTOR_GA_POLICY_PATH
  ? path.resolve(process.env.EXECUTION_DOCTOR_GA_POLICY_PATH)
  : path.join(ROOT, 'config', 'execution_doctor_ga_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 220) {
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
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

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return todayUtc();
}

function parseMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function safeRate(num: unknown, den: unknown, fallback = 0) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return fallback;
  return n / d;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    rolling_days: 30,
    thresholds: {
      max_unhandled_executor_failures: 0,
      min_known_auto_handle_rate: 0.99,
      min_unknown_route_coverage: 1.0,
      require_unknown_signature_routing: true
    },
    samples: {
      min_executor_runs: 3,
      min_doctor_runs: 3
    },
    paths: {
      workflow_history: 'state/adaptive/workflows/executor/history.jsonl',
      doctor_history: 'state/ops/autotest_doctor/history.jsonl',
      latest: 'state/ops/execution_doctor_ga/latest.json',
      history: 'state/ops/execution_doctor_ga/history.jsonl'
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw && raw.thresholds && typeof raw.thresholds === 'object'
    ? raw.thresholds
    : {};
  const samples = raw && raw.samples && typeof raw.samples === 'object'
    ? raw.samples
    : {};
  const pathsCfg = raw && raw.paths && typeof raw.paths === 'object'
    ? raw.paths
    : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    rolling_days: clampInt(raw.rolling_days, 1, 365, base.rolling_days),
    thresholds: {
      max_unhandled_executor_failures: clampInt(
        thresholds.max_unhandled_executor_failures,
        0,
        100000,
        base.thresholds.max_unhandled_executor_failures
      ),
      min_known_auto_handle_rate: clampNumber(
        thresholds.min_known_auto_handle_rate,
        0,
        1,
        base.thresholds.min_known_auto_handle_rate
      ),
      min_unknown_route_coverage: clampNumber(
        thresholds.min_unknown_route_coverage,
        0,
        1,
        base.thresholds.min_unknown_route_coverage
      ),
      require_unknown_signature_routing: toBool(
        thresholds.require_unknown_signature_routing,
        base.thresholds.require_unknown_signature_routing
      )
    },
    samples: {
      min_executor_runs: clampInt(samples.min_executor_runs, 1, 10000, base.samples.min_executor_runs),
      min_doctor_runs: clampInt(samples.min_doctor_runs, 1, 10000, base.samples.min_doctor_runs)
    },
    paths: {
      workflow_history: resolvePath(pathsCfg.workflow_history, base.paths.workflow_history),
      doctor_history: resolvePath(pathsCfg.doctor_history, base.paths.doctor_history),
      latest: resolvePath(pathsCfg.latest, base.paths.latest),
      history: resolvePath(pathsCfg.history, base.paths.history)
    }
  };
}

function inWindow(row: AnyObj, minMs: number, maxMs: number) {
  const tsMs = parseMs(row && row.ts);
  if (!Number.isFinite(tsMs)) return false;
  return Number(tsMs) >= minMs && Number(tsMs) <= maxMs;
}

function runGate(args: AnyObj) {
  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const date = toDate(args.date || args._[1]);
  const nowMs = Date.parse(`${date}T23:59:59.999Z`);
  const maxMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const minMs = maxMs - (Number(policy.rolling_days || 30) * 24 * 60 * 60 * 1000);

  const workflowRows = readJsonl(policy.paths.workflow_history)
    .filter((row) => inWindow(row, minMs, maxMs));
  const doctorRows = readJsonl(policy.paths.doctor_history)
    .filter((row) => inWindow(row, minMs, maxMs));

  const workflowRuns = workflowRows.length;
  const doctorRuns = doctorRows.length;

  const unhandledFailures = workflowRows.reduce((sum: number, row: AnyObj) => {
    const direct = Number(row && row.unhandled_failures);
    if (Number.isFinite(direct) && direct >= 0) return sum + direct;
    const failed = Number(row && row.workflows_failed || 0);
    const blocked = Number(row && row.workflows_blocked || 0);
    return sum + Math.max(0, failed - blocked);
  }, 0);

  const knownCandidates = doctorRows.reduce((sum: number, row: AnyObj) => (
    sum + Math.max(0, Number(row && row.known_signature_candidates || 0))
  ), 0);
  const knownHandled = doctorRows.reduce((sum: number, row: AnyObj) => (
    sum + Math.max(0, Number(row && row.known_signature_auto_handled || 0))
  ), 0);
  const knownHandleRate = Number(safeRate(knownHandled, knownCandidates, 1).toFixed(4));

  const unknownCount = doctorRows.reduce((sum: number, row: AnyObj) => (
    sum + Math.max(0, Number(row && row.unknown_signature_count || 0))
  ), 0);
  const unknownRouted = doctorRows.reduce((sum: number, row: AnyObj) => (
    sum + Math.max(0, Number(row && row.unknown_signature_routes || 0))
  ), 0);
  const unknownRouteCoverage = Number(safeRate(unknownRouted, unknownCount, 1).toFixed(4));

  const checks = {
    policy_enabled: policy.enabled === true,
    executor_samples: workflowRuns >= Number(policy.samples.min_executor_runs || 1),
    doctor_samples: doctorRuns >= Number(policy.samples.min_doctor_runs || 1),
    unhandled_failures: unhandledFailures <= Number(policy.thresholds.max_unhandled_executor_failures || 0),
    known_auto_handle_rate: knownHandleRate >= Number(policy.thresholds.min_known_auto_handle_rate || 0.99),
    unknown_signature_routing: policy.thresholds.require_unknown_signature_routing === true
      ? unknownRouteCoverage >= Number(policy.thresholds.min_unknown_route_coverage || 1)
      : true
  };

  const pass = checks.policy_enabled
    && checks.executor_samples
    && checks.doctor_samples
    && checks.unhandled_failures
    && checks.known_auto_handle_rate
    && checks.unknown_signature_routing;

  const payload = {
    ok: pass || strict !== true,
    type: 'execution_doctor_ga',
    ts: nowIso(),
    date,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    rolling_days: policy.rolling_days,
    checks,
    metrics: {
      workflow_runs: workflowRuns,
      doctor_runs: doctorRuns,
      unhandled_failures: unhandledFailures,
      known_signature_candidates: knownCandidates,
      known_signature_auto_handled: knownHandled,
      known_signature_auto_handle_rate: knownHandleRate,
      unknown_signature_count: unknownCount,
      unknown_signature_routes: unknownRouted,
      unknown_signature_route_coverage: unknownRouteCoverage
    },
    thresholds: {
      max_unhandled_executor_failures: policy.thresholds.max_unhandled_executor_failures,
      min_known_auto_handle_rate: policy.thresholds.min_known_auto_handle_rate,
      min_unknown_route_coverage: policy.thresholds.min_unknown_route_coverage,
      require_unknown_signature_routing: policy.thresholds.require_unknown_signature_routing,
      min_executor_runs: policy.samples.min_executor_runs,
      min_doctor_runs: policy.samples.min_doctor_runs
    },
    pass
  };

  writeJsonAtomic(policy.paths.latest, payload);
  appendJsonl(policy.paths.history, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict === true && pass !== true) process.exit(1);
}

function statusCmd(args: AnyObj) {
  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.paths.latest, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'execution_doctor_ga_status',
      error: 'execution_doctor_ga_latest_missing',
      latest_path: relPath(policy.paths.latest)
    })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'execution_doctor_ga_status',
    ts: payload.ts || null,
    date: payload.date || null,
    pass: payload.pass === true,
    checks: payload.checks || {},
    metrics: payload.metrics || {},
    latest_path: relPath(policy.paths.latest),
    history_path: relPath(policy.paths.history)
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/execution_doctor_ga.js run [--policy=path] [--date=YYYY-MM-DD] [--strict=1]');
  console.log('  node systems/ops/execution_doctor_ga.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 24).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runGate(args);
  if (cmd === 'status') return statusCmd(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'execution_doctor_ga',
      error: clean(err && err.message ? err.message : err || 'execution_doctor_ga_failed', 240)
    })}\n`);
    process.exit(1);
  }
}


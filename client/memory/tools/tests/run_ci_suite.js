#!/usr/bin/env node
/**
 * Stable CI test runner.
 * - Runs deterministic contract + test checks.
 * - Excludes known stateful smoke tests unless explicitly requested.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const pkg = path.join(dir, 'package.json');
    const cargo = path.join(dir, 'Cargo.toml');
    const clientDir = path.join(dir, 'client');
    if (fs.existsSync(pkg) && (fs.existsSync(cargo) || fs.existsSync(clientDir))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(__dirname, '..', '..', '..');
    dir = parent;
  }
}

const REPO_ROOT = resolveRepoRoot(__dirname);
const CLIENT_ROOT = fs.existsSync(path.join(REPO_ROOT, 'client')) ? path.join(REPO_ROOT, 'client') : REPO_ROOT;
const TEST_DIR = path.join(CLIENT_ROOT, 'memory', 'tools', 'tests');
const INCLUDE_STATEFUL = process.argv.includes('--include-stateful');
const CI_STREAK_STATE_PATH = path.join(REPO_ROOT, 'state', 'ops', 'ci_baseline_streak.json');
const DEFAULT_STEP_TIMEOUT_MS = Math.max(30_000, Number(process.env.CI_STEP_TIMEOUT_MS || (12 * 60 * 1000)));
const DEFAULT_TEST_TIMEOUT_MS = Math.max(15_000, Number(process.env.CI_TEST_TIMEOUT_MS || (5 * 60 * 1000)));
const DEFAULT_TOTAL_TIMEOUT_MS = Math.max(DEFAULT_STEP_TIMEOUT_MS, Number(process.env.CI_TOTAL_TIMEOUT_MS || (45 * 60 * 1000)));
const TEST_TIMEOUT_OVERRIDES_MS = {
  // This suite runs many real subprocess scenarios and regularly exceeds 5m.
  'inversion_controller.test.js': Math.max(DEFAULT_TEST_TIMEOUT_MS, 10 * 60 * 1000)
};

const DEFAULT_EXCLUDES = new Set([
  'enforcement.smoke.test.js',
  'skill_gate.smoke.test.js'
]);

function listTests() {
  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  if (INCLUDE_STATEFUL) return files;
  return files.filter((f) => !DEFAULT_EXCLUDES.has(f));
}

function runNode(args, opts = {}) {
  const env = { ...process.env };
  if (!env.OUTCOME_FITNESS_POLICY_PATH) {
    env.OUTCOME_FITNESS_POLICY_PATH = path.join(TEST_DIR, '__no_outcome_policy__.json');
  }
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs || DEFAULT_STEP_TIMEOUT_MS));
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: timeoutMs
  });
  const timedOut = !!(r.error && String(r.error.code || '').toUpperCase() === 'ETIMEDOUT');
  return {
    ok: r.status === 0 && !timedOut,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    error_code: r.error ? String(r.error.code || '') : null
  };
}

function resolveNodeScriptArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return args;
  const first = String(args[0] || '');
  if (!first || first.startsWith('-')) return args;

  const abs = path.isAbsolute(first) ? first : path.join(REPO_ROOT, first);
  if (fs.existsSync(abs)) return args;

  if (!first.endsWith('.js')) return args;
  const tsAbs = abs.slice(0, -3) + '.ts';
  if (!fs.existsSync(tsAbs)) return args;

  const tsEntrypointAbs = path.join(CLIENT_ROOT, 'lib', 'ts_entrypoint.js');
  if (!fs.existsSync(tsEntrypointAbs)) return args;

  const entryArg = path.relative(REPO_ROOT, tsEntrypointAbs).replace(/\\/g, '/');
  const tsArg = path.relative(REPO_ROOT, tsAbs).replace(/\\/g, '/');
  return [entryArg, tsArg, ...args.slice(1)];
}

function printOutput(prefix, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const lines = trimmed.split('\n').slice(0, 120);
  for (const line of lines) {
    console.log(`${prefix}${line}`);
  }
}

function elapsedMs(startMs) {
  return Date.now() - Number(startMs || Date.now());
}

function ensureTotalBudget(startMs, phase) {
  const used = elapsedMs(startMs);
  if (used <= DEFAULT_TOTAL_TIMEOUT_MS) return;
  console.error(`CI total timeout exceeded during ${phase}: used=${used}ms cap=${DEFAULT_TOTAL_TIMEOUT_MS}ms`);
  process.exit(124);
}

function runCiStep(stepName, args, timeoutMs, startedAtMs) {
  ensureTotalBudget(startedAtMs, stepName);
  console.log(`=== CI SUITE: ${stepName} ===`);
  const started = Date.now();
  const out = runNode(resolveNodeScriptArgs(args), { timeoutMs });
  printOutput('  ', out.stdout);
  printOutput('  ', out.stderr);
  const tookMs = Date.now() - started;
  console.log(`  duration_ms=${tookMs}`);
  if (!out.ok) {
    if (out.timed_out) {
      console.error(`${stepName} timed out after ${out.timeout_ms}ms`);
    } else {
      console.error(`${stepName} failed (exit ${out.status})`);
    }
    process.exit(out.status || (out.timed_out ? 124 : 1));
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function dateOnlyUtc(tsIso) {
  return String(tsIso || '').slice(0, 10);
}

function sortDescDate(a, b) {
  return b.localeCompare(a);
}

function prevDateUtc(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function computeConsecutiveDailyGreen(history) {
  const byDay = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const day = String(row && row.date || '').trim();
    if (!day) continue;
    const prev = byDay.get(day);
    if (!prev || String(row.ts || '') > String(prev.ts || '')) {
      byDay.set(day, row);
    }
  }
  const days = Array.from(byDay.keys()).sort(sortDescDate);
  if (days.length === 0) return { streak: 0, latest_green_date: null };

  let streak = 0;
  let expect = days[0];
  for (const day of days) {
    if (day !== expect) break;
    const row = byDay.get(day);
    if (!row || row.ok !== true) break;
    streak += 1;
    expect = prevDateUtc(expect);
  }

  return {
    streak,
    latest_green_date: streak > 0 ? days[0] : null
  };
}

function recordCiRun(outcome) {
  const now = new Date().toISOString();
  const base = readJsonSafe(CI_STREAK_STATE_PATH, {});
  const history = Array.isArray(base.history) ? base.history.slice(-59) : [];
  history.push({
    ts: now,
    date: dateOnlyUtc(now),
    ok: outcome.ok === true,
    passed: Number(outcome.passed || 0),
    failed: Number(outcome.failed || 0),
    total: Number(outcome.total || 0),
    include_stateful: outcome.include_stateful === true
  });
  const streak = computeConsecutiveDailyGreen(history);
  const out = {
    schema_id: 'ci_baseline_streak',
    schema_version: '1.0',
    updated_at: now,
    target_days: 7,
    consecutive_daily_green_runs: streak.streak,
    latest_green_date: streak.latest_green_date,
    history
  };
  writeJsonAtomic(CI_STREAK_STATE_PATH, out);
  return out;
}

function main() {
  const ciStartedAtMs = Date.now();
  runCiStep('typecheck_systems', ['client/systems/ops/typecheck_systems.js'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('ts_clone_drift_guard', ['client/systems/ops/ts_clone_drift_guard.js', '--baseline=config/ts_clone_drift_baseline.json'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('js_holdout_audit_advisory', ['client/systems/ops/js_holdout_audit.js', 'run', '--strict=0'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('contract_check', ['client/systems/spine/contract_check.js'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('integrity_kernel', ['client/systems/security/integrity_kernel.js', 'run'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('adaptive_layer_guard_strict', ['client/systems/sensory/adaptive_layer_guard.js', 'run', '--strict'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('adaptive_layer_boundary', ['client/memory/tools/tests/adaptive_layer_boundary_guards.test.js'], DEFAULT_TEST_TIMEOUT_MS, ciStartedAtMs);
  runCiStep('schema_contract_check', ['client/systems/security/schema_contract_check.js', 'run'], DEFAULT_STEP_TIMEOUT_MS, ciStartedAtMs);

  const tests = listTests();
  let failed = 0;
  let passed = 0;

  console.log(`=== CI SUITE: tests (${tests.length}) ===`);
  for (const file of tests) {
    ensureTotalBudget(ciStartedAtMs, `tests:${file}`);
    const rel = path.relative(REPO_ROOT, path.join(TEST_DIR, file));
    console.log(`-> ${rel}`);
    const timeoutMs = Number(TEST_TIMEOUT_OVERRIDES_MS[file] || DEFAULT_TEST_TIMEOUT_MS);
    const res = runNode([rel], { timeoutMs });
    if (res.ok) {
      passed += 1;
      continue;
    }
    failed += 1;
    if (res.timed_out) {
      console.error(`FAIL: ${rel} (timeout ${res.timeout_ms}ms)`);
    } else {
      console.error(`FAIL: ${rel} (exit ${res.status})`);
    }
    printOutput('  ', res.stdout);
    printOutput('  ', res.stderr);
  }

  console.log(`=== CI RESULT: passed=${passed} failed=${failed} ===`);
  const ciDurationMs = Date.now() - ciStartedAtMs;
  const qualityScorecard = runNode([
    'client/systems/ops/ci_quality_scorecard.js',
    'check',
    '--strict=0',
    `--critical-suite-pass=${failed === 0 ? '1' : '0'}`,
    `--duration-ms=${ciDurationMs}`
  ], { timeoutMs: 60_000 });
  if (!qualityScorecard.ok) {
    printOutput('  ', qualityScorecard.stdout);
    printOutput('  ', qualityScorecard.stderr);
  }
  const streakState = recordCiRun({
    ok: failed === 0,
    passed,
    failed,
    total: tests.length,
    include_stateful: INCLUDE_STATEFUL
  });
  console.log(`=== CI BASELINE STREAK: ${streakState.consecutive_daily_green_runs}/${streakState.target_days} days ===`);
  if (failed > 0) process.exit(1);
}

main();

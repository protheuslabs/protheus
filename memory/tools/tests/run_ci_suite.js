#!/usr/bin/env node
/**
 * Stable CI test runner.
 * - Runs deterministic contract + test checks.
 * - Excludes known stateful smoke tests unless explicitly requested.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_DIR = path.join(ROOT, 'memory', 'tools', 'tests');
const INCLUDE_STATEFUL = process.argv.includes('--include-stateful');
const CI_STREAK_STATE_PATH = path.join(ROOT, 'state', 'ops', 'ci_baseline_streak.json');

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

function runNode(args) {
  const env = { ...process.env };
  if (!env.OUTCOME_FITNESS_POLICY_PATH) {
    env.OUTCOME_FITNESS_POLICY_PATH = path.join(TEST_DIR, '__no_outcome_policy__.json');
  }
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || ''
  };
}

function printOutput(prefix, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const lines = trimmed.split('\n').slice(0, 120);
  for (const line of lines) {
    console.log(`${prefix}${line}`);
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
  console.log('=== CI SUITE: typecheck_systems ===');
  const typecheck = runNode(['systems/ops/typecheck_systems.js']);
  printOutput('  ', typecheck.stdout);
  printOutput('  ', typecheck.stderr);
  if (!typecheck.ok) {
    console.error(`typecheck_systems failed (exit ${typecheck.status})`);
    process.exit(typecheck.status || 1);
  }

  console.log('=== CI SUITE: ts_clone_drift_guard ===');
  const tsCloneGuard = runNode(['systems/ops/ts_clone_drift_guard.js', '--baseline=config/ts_clone_drift_baseline.json']);
  printOutput('  ', tsCloneGuard.stdout);
  printOutput('  ', tsCloneGuard.stderr);
  if (!tsCloneGuard.ok) {
    console.error(`ts_clone_drift_guard failed (exit ${tsCloneGuard.status})`);
    process.exit(tsCloneGuard.status || 1);
  }

  console.log('=== CI SUITE: js_holdout_audit ===');
  const jsHoldout = runNode(['systems/ops/js_holdout_audit.js', 'run', '--strict=1']);
  printOutput('  ', jsHoldout.stdout);
  printOutput('  ', jsHoldout.stderr);
  if (!jsHoldout.ok) {
    console.error(`js_holdout_audit failed (exit ${jsHoldout.status})`);
    process.exit(jsHoldout.status || 1);
  }

  console.log('=== CI SUITE: contract_check ===');
  const contract = runNode(['systems/spine/contract_check.js']);
  printOutput('  ', contract.stdout);
  printOutput('  ', contract.stderr);
  if (!contract.ok) {
    console.error(`contract_check failed (exit ${contract.status})`);
    process.exit(contract.status || 1);
  }

  console.log('=== CI SUITE: integrity_kernel ===');
  const integrity = runNode(['systems/security/integrity_kernel.js', 'run']);
  printOutput('  ', integrity.stdout);
  printOutput('  ', integrity.stderr);
  if (!integrity.ok) {
    console.error(`integrity_kernel failed (exit ${integrity.status})`);
    process.exit(integrity.status || 1);
  }

  console.log('=== CI SUITE: adaptive_layer_guard (strict) ===');
  const adaptiveGuard = runNode(['systems/sensory/adaptive_layer_guard.js', 'run', '--strict']);
  printOutput('  ', adaptiveGuard.stdout);
  printOutput('  ', adaptiveGuard.stderr);
  if (!adaptiveGuard.ok) {
    console.error(`adaptive_layer_guard failed (exit ${adaptiveGuard.status})`);
    process.exit(adaptiveGuard.status || 1);
  }

  console.log('=== CI SUITE: adaptive_layer_boundary ===');
  const adaptiveBoundary = runNode(['memory/tools/tests/adaptive_layer_boundary_guards.test.js']);
  printOutput('  ', adaptiveBoundary.stdout);
  printOutput('  ', adaptiveBoundary.stderr);
  if (!adaptiveBoundary.ok) {
    console.error(`adaptive_layer_boundary_guards failed (exit ${adaptiveBoundary.status})`);
    process.exit(adaptiveBoundary.status || 1);
  }

  console.log('=== CI SUITE: schema_contract_check ===');
  const schemaContract = runNode(['systems/security/schema_contract_check.js', 'run']);
  printOutput('  ', schemaContract.stdout);
  printOutput('  ', schemaContract.stderr);
  if (!schemaContract.ok) {
    console.error(`schema_contract_check failed (exit ${schemaContract.status})`);
    process.exit(schemaContract.status || 1);
  }

  const tests = listTests();
  let failed = 0;
  let passed = 0;

  console.log(`=== CI SUITE: tests (${tests.length}) ===`);
  for (const file of tests) {
    const rel = path.join('memory', 'tools', 'tests', file);
    console.log(`-> ${rel}`);
    const res = runNode([rel]);
    if (res.ok) {
      passed += 1;
      continue;
    }
    failed += 1;
    console.error(`FAIL: ${rel} (exit ${res.status})`);
    printOutput('  ', res.stdout);
    printOutput('  ', res.stderr);
  }

  console.log(`=== CI RESULT: passed=${passed} failed=${failed} ===`);
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

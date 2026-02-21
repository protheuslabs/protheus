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

function main() {
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
  if (failed > 0) process.exit(1);
}

main();

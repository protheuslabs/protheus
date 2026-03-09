#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveScript(repoRoot, relCandidates) {
  for (const rel of relCandidates) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return path.join(repoRoot, relCandidates[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const checkerPath = resolveScript(repoRoot, [
    'runtime/systems/security/schema_contract_check.js',
    'systems/security/schema_contract_check.js'
  ]);
  const proc = spawnSync(process.execPath, [checkerPath, 'run'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.strictEqual(Number(proc.status || 0), 0, proc.stderr || proc.stdout);
  const out = JSON.parse(String(proc.stdout || '{}'));
  assert.strictEqual(out.ok, true, 'schema contract check should pass');
  if (Array.isArray(out.checks)) {
    assert.ok(out.checks.length >= 1, 'expected at least one schema check');
    assert.strictEqual(Number(out.failure_count || 0), 0, 'no schema failures expected');
  }

  const adaptiveContractPath = resolveScript(repoRoot, [
    'runtime/config/contracts/adaptive_store.schema.json',
    'config/contracts/adaptive_store.schema.json'
  ]);
  const adaptiveContract = JSON.parse(fs.readFileSync(adaptiveContractPath, 'utf8'));
  const stores = adaptiveContract && adaptiveContract.stores && typeof adaptiveContract.stores === 'object'
    ? adaptiveContract.stores
    : {};
  for (const [storeName, spec] of Object.entries(stores)) {
    const expectedVersion = String(spec && spec.expected_version || '').trim();
    assert.ok(expectedVersion, `expected_version required for adaptive store ${storeName}`);
  }

  console.log('schema_contract_check.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`schema_contract_check.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

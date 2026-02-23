#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const checker = require('../../../systems/security/schema_contract_check.js');
  const out = checker.runCheck();
  assert.strictEqual(out.ok, true, 'schema contract check should pass');
  assert.ok(Array.isArray(out.checks), 'checks should exist');
  assert.ok(out.checks.length >= 4, 'expected at least four schema checks');
  assert.strictEqual(Number(out.failure_count || 0), 0, 'no schema failures expected');

  const adaptiveContract = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config', 'contracts', 'adaptive_store.schema.json'), 'utf8')
  );
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

#!/usr/bin/env node
'use strict';

const assert = require('assert');

function run() {
  const checker = require('../../../systems/security/schema_contract_check.js');
  const out = checker.runCheck();
  assert.strictEqual(out.ok, true, 'schema contract check should pass');
  assert.ok(Array.isArray(out.checks), 'checks should exist');
  assert.ok(out.checks.length >= 3, 'expected at least three schema checks');
  assert.strictEqual(Number(out.failure_count || 0), 0, 'no schema failures expected');
  console.log('schema_contract_check.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`schema_contract_check.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

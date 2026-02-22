#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

process.env.AUTONOMY_POSTCHECK_CONTRACT = '0';
process.env.AUTONOMY_POSTCHECK_ADAPTER_TESTS = '0';
process.env.AUTONOMY_POSTCHECK_EXTERNAL_VERIFY = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const { runPostconditions } = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function main() {
  const verified = runPostconditions(
    { kind: 'moltbook_publish', params: {} },
    { summary: { decision: 'ACTUATE', dry_run: false, verified: true } }
  );
  assert.strictEqual(verified.passed, true, 'verified actuation should pass postconditions');
  assert.ok(Array.isArray(verified.checks), 'checks should be present');
  assert.ok(verified.checks.some((c) => c.name === 'actuation_verified' && c.pass === true), 'actuation_verified check should pass');

  const unverified = runPostconditions(
    { kind: 'moltbook_publish', params: {} },
    { summary: { decision: 'ACTUATE', dry_run: false, verified: false } }
  );
  assert.strictEqual(unverified.passed, false, 'unverified actuation should fail postconditions');
  assert.ok(Array.isArray(unverified.failed) && unverified.failed.includes('actuation_verified'), 'expected actuation_verified failure');

  const dryRun = runPostconditions(
    { kind: 'moltbook_publish', params: {} },
    { summary: { decision: 'ACTUATE', dry_run: true, verified: false } }
  );
  assert.strictEqual(dryRun.passed, true, 'dry-run actuation should skip verified postcheck');
  assert.ok(!dryRun.checks.some((c) => c.name === 'actuation_verified'), 'dry-run should skip actuation_verified check');

  console.log('autonomy_postconditions.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`autonomy_postconditions.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

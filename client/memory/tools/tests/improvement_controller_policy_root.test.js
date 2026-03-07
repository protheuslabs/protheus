#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(repoRoot, 'systems', 'autonomy', 'improvement_controller.js'));

  const denied = mod.policyRootDecision({
    scope: 'autonomy_self_change_apply',
    target: 'commit:abc123',
    approval_note: 'start validated upgrade',
    lease_token: ''
  }, () => ({
    ok: false,
    code: 1,
    payload: { ok: false, reason: 'lease_token_required' },
    stdout: '',
    stderr: ''
  }));
  assert.strictEqual(denied.required, true, 'policy root should be required by default');
  assert.strictEqual(denied.ok, false, 'decision without valid lease should fail');
  assert.strictEqual(denied.reason, 'lease_token_required', 'deny reason should propagate');

  const allowed = mod.policyRootDecision({
    scope: 'autonomy_self_change_apply',
    target: 'commit:def456',
    approval_note: 'start validated upgrade',
    lease_token: 'lease-token-present'
  }, () => ({
    ok: true,
    code: 0,
    payload: { ok: true, decision: 'ALLOW', reason: 'lease_verified' },
    stdout: '',
    stderr: ''
  }));
  assert.strictEqual(allowed.required, true);
  assert.strictEqual(allowed.ok, true, 'decision with valid lease should pass');
  assert.strictEqual(allowed.reason, 'lease_verified');

  console.log('improvement_controller_policy_root.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`improvement_controller_policy_root.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


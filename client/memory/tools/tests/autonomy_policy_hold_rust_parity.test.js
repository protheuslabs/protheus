#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  const budgetHold = controller.routeExecutionPolicyHold(
    {
      gate_decision: 'ALLOW',
      route_decision_raw: 'ALLOW',
      needs_manual_review: false,
      executable: true,
      budget_block_reason: 'budget guard blocked'
    },
    'route'
  );
  assert.strictEqual(budgetHold.hold, true, 'budget guard should hold route execution');
  assert.strictEqual(budgetHold.hold_scope, 'budget');

  const manualHold = controller.routeExecutionPolicyHold(
    {
      gate_decision: 'MANUAL',
      route_decision_raw: 'ALLOW',
      needs_manual_review: false,
      executable: false
    },
    'route'
  );
  assert.strictEqual(manualHold.hold, true, 'manual + non-executable should hold');
  assert.strictEqual(manualHold.hold_scope, 'proposal');
  assert.strictEqual(manualHold.hold_reason, 'gate_manual');

  const noHold = controller.routeExecutionPolicyHold(
    {
      gate_decision: 'ALLOW',
      route_decision_raw: 'ALLOW',
      needs_manual_review: false,
      executable: true
    },
    'route'
  );
  assert.strictEqual(noHold.hold, false, 'allow + executable should not hold');

  console.log('autonomy_policy_hold_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

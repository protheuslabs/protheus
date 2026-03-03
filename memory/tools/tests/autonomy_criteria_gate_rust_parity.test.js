#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  const blocked = controller.preExecCriteriaGateDecision(
    {
      min_count: 2,
      total_count: 2,
      contract_not_allowed_count: 1,
      unsupported_count: 0,
      structurally_supported_count: 1,
      contract: { violation_count: 1 }
    },
    { min_count: 2 }
  );
  assert.strictEqual(blocked.pass, false, 'contract violation should fail criteria gate');
  assert.ok(
    Array.isArray(blocked.reasons) && blocked.reasons.includes('criteria_contract_violation'),
    'criteria gate should include contract violation reason'
  );

  const pass = controller.preExecCriteriaGateDecision(
    {
      min_count: 2,
      total_count: 3,
      contract_not_allowed_count: 0,
      unsupported_count: 0,
      structurally_supported_count: 3,
      contract: { violation_count: 0 }
    },
    { min_count: 2 }
  );
  assert.strictEqual(pass.pass, true, 'sufficient criteria support should pass gate');
  assert.deepStrictEqual(pass.reasons, []);

  console.log('autonomy_criteria_gate_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_criteria_gate_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

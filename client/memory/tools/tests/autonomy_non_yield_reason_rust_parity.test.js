#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const cases = [
    {
      evt: { hold_reason: 'Gate Manual', result: 'stop_init_gate_readiness' },
      category: 'policy_hold'
    },
    {
      evt: { result: 'executed', outcome: 'no_change' },
      category: 'no_progress'
    },
    {
      evt: { result: 'stop_repeat_gate_human_escalation_pending' },
      category: 'safety_stop'
    },
    {
      evt: { result: '' },
      category: 'non_yield'
    }
  ];

  for (const row of cases) {
    const tsVal = loadController(false).nonYieldReasonFromRun(row.evt, row.category);
    const rustVal = loadController(true).nonYieldReasonFromRun(row.evt, row.category);
    assert.strictEqual(
      rustVal,
      tsVal,
      `nonYieldReasonFromRun parity mismatch for ${row.category}`
    );
  }

  console.log('autonomy_non_yield_reason_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_non_yield_reason_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    { type: 'autonomy_run', result: 'no_candidates_policy_daily_cap', policy_hold: true, hold_reason: 'budget guard blocked' },
    { type: 'autonomy_run', result: 'stop_init_gate_readiness', policy_hold: true, hold_reason: 'gate_manual' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_human_escalation_pending' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped' },
    { type: 'autonomy_run', result: 'lock_busy' },
    { type: 'other_event', result: 'stop_repeat_gate_no_progress' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).classifyNonYieldCategory(evt);
    const rustVal = loadController(true).classifyNonYieldCategory(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `classifyNonYieldCategory parity mismatch for ${evt.type}/${evt.result}/${evt.outcome || ''}`
    );
  }

  console.log('autonomy_non_yield_category_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_non_yield_category_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

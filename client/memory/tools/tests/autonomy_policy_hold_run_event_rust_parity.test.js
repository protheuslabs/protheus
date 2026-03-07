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
    { type: 'autonomy_run', policy_hold: true, result: 'executed' },
    { type: 'autonomy_run', policy_hold: false, result: 'stop_init_gate_readiness' },
    { type: 'autonomy_run', policy_hold: false, result: 'score_only_fallback_route_block' },
    { type: 'autonomy_run', policy_hold: false, result: 'executed' },
    { type: 'other_event', policy_hold: true, result: 'stop_init_gate_readiness' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).isPolicyHoldRunEvent(evt);
    const rustVal = loadController(true).isPolicyHoldRunEvent(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isPolicyHoldRunEvent parity mismatch for ${evt.type}/${evt.result}`
    );
  }

  console.log('autonomy_policy_hold_run_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_run_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_capability_cap' },
    { type: 'autonomy_run', result: 'stop_init_gate_quality_exhausted' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted' },
    { type: 'autonomy_run', result: 'executed' },
    { type: 'autonomy_run', result: 'score_only_preview' },
    { type: 'other_event', result: 'stop_repeat_gate_stale_signal' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).isGateExhaustedAttempt(evt);
    const rustVal = loadController(true).isGateExhaustedAttempt(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isGateExhaustedAttempt parity mismatch for ${evt.type}/${evt.result}`
    );
  }

  console.log('autonomy_gate_exhausted_attempt_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_gate_exhausted_attempt_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

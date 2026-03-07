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
    [
      { type: 'autonomy_run', result: 'executed' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted' }
    ],
    [
      { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted' },
      { type: 'autonomy_run', result: 'lock_busy' }
    ],
    [
      { type: 'other_event', result: 'stop_repeat_gate_candidate_exhausted' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_directive_pulse_cooldown' }
    ],
    []
  ];

  for (const events of cases) {
    const tsVal = loadController(false).consecutiveGateExhaustedAttempts(events);
    const rustVal = loadController(true).consecutiveGateExhaustedAttempts(events);
    assert.strictEqual(
      rustVal,
      tsVal,
      `consecutiveGateExhaustedAttempts parity mismatch for ${JSON.stringify(events)}`
    );
  }

  console.log('autonomy_consecutive_gate_exhausted_attempts_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_consecutive_gate_exhausted_attempts_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

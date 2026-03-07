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
    { type: 'autonomy_run', result: 'stop_repeat_gate_human_escalation_pending' },
    { type: 'autonomy_run', result: 'stop_init_gate_tier1_governance' },
    { type: 'autonomy_run', result: 'stop_init_gate_medium_risk_guard' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_capability_cooldown' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_directive_pulse_tier_reservation' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' },
    { type: 'other_event', result: 'stop_repeat_gate_human_escalation_pending' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).isSafetyStopRunEvent(evt);
    const rustVal = loadController(true).isSafetyStopRunEvent(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isSafetyStopRunEvent parity mismatch for ${evt.type}/${evt.result}`
    );
  }

  console.log('autonomy_safety_stop_run_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_safety_stop_run_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

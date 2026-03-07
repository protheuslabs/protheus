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
    { type: 'autonomy_run', result: 'executed', policy_hold: false, proposal_id: '' },
    { type: 'autonomy_run', result: 'stop_init_gate_readiness', policy_hold: false, proposal_id: 'p-001' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted', policy_hold: false, proposal_id: 'p-001' },
    { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted', policy_hold: false, proposal_id: '' },
    { type: 'autonomy_run', result: 'score_only_preview', policy_hold: false, proposal_id: 'p-001' },
    { type: 'autonomy_run', result: 'lock_busy', policy_hold: false, proposal_id: 'p-001' },
    { type: 'other_event', result: 'executed', policy_hold: false, proposal_id: 'p-001' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).isCapacityCountedAttemptEvent(evt);
    const rustVal = loadController(true).isCapacityCountedAttemptEvent(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `isCapacityCountedAttemptEvent parity mismatch for ${evt.type}/${evt.result}/${evt.proposal_id}`
    );
  }

  console.log('autonomy_capacity_counted_attempt_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_capacity_counted_attempt_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

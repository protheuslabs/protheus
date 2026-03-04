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
      { type: 'autonomy_run', result: 'executed', proposal_id: 'p1' },
      { type: 'autonomy_run', result: 'lock_busy', proposal_id: 'p2' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted', proposal_id: 'p3' }
    ],
    [
      { type: 'autonomy_run', result: 'executed', policy_hold: true, proposal_id: 'p1' },
      { type: 'autonomy_run', result: 'score_only_preview', proposal_id: 'p2' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal', proposal_id: 'p3' }
    ],
    []
  ];

  for (const events of cases) {
    const tsVal = loadController(false).capacityCountedAttemptEvents(events);
    const rustVal = loadController(true).capacityCountedAttemptEvents(events);
    assert.deepStrictEqual(
      rustVal,
      tsVal,
      `capacityCountedAttemptEvents parity mismatch for ${JSON.stringify(events)}`
    );
  }

  console.log('autonomy_capacity_counted_attempt_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_capacity_counted_attempt_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

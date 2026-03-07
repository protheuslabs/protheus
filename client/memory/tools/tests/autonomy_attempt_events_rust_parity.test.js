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
      { type: 'autonomy_run', result: 'stop_repeat_gate_candidate_exhausted' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' },
      { type: 'outcome', result: 'executed' }
    ],
    [
      { type: 'autonomy_run', result: 'init_gate_stub' },
      { type: 'autonomy_run', result: 'lock_busy' },
      { type: 'autonomy_run', result: 'stop_init_gate_quality_exhausted' }
    ],
    []
  ];

  for (const events of cases) {
    const tsVal = loadController(false).attemptEvents(events);
    const rustVal = loadController(true).attemptEvents(events);
    assert.deepStrictEqual(
      rustVal,
      tsVal,
      `attemptEvents parity mismatch for ${JSON.stringify(events)}`
    );
  }

  console.log('autonomy_attempt_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_attempt_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

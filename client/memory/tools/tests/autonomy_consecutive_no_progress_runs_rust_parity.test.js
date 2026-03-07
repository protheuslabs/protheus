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
      { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' },
      { type: 'autonomy_run', result: 'executed', outcome: 'no_change' }
    ],
    [
      { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' },
      { type: 'autonomy_run', result: 'executed', outcome: 'shipped' }
    ],
    [
      { type: 'outcome', result: 'ignored' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_no_progress' }
    ],
    []
  ];

  for (const events of cases) {
    const tsVal = loadController(false).consecutiveNoProgressRuns(events);
    const rustVal = loadController(true).consecutiveNoProgressRuns(events);
    assert.strictEqual(
      rustVal,
      tsVal,
      `consecutiveNoProgressRuns parity mismatch for ${JSON.stringify(events)}`
    );
  }

  console.log('autonomy_consecutive_no_progress_runs_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_consecutive_no_progress_runs_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

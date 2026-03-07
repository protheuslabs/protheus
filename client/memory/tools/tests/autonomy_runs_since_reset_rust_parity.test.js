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
      { type: 'autonomy_reset' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal' }
    ],
    [
      { type: 'autonomy_run', result: 'executed' },
      { type: 'autonomy_run', result: 'stop_repeat_gate_stale_signal' }
    ],
    [
      { type: 'autonomy_reset' },
      { type: 'autonomy_run', result: 'executed' },
      { type: 'autonomy_reset' },
      { type: 'autonomy_run', result: 'executed' }
    ]
  ];

  for (const events of cases) {
    const tsVal = loadController(false).runsSinceReset(events);
    const rustVal = loadController(true).runsSinceReset(events);
    assert.deepStrictEqual(
      rustVal,
      tsVal,
      `runsSinceReset parity mismatch for ${JSON.stringify(events)}`
    );
  }

  console.log('autonomy_runs_since_reset_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_runs_since_reset_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    { executed: 3, stop_repeat_gate_no_progress: 2, init_gate_stub: 2 },
    {},
    { unknown: 0, executed: 1 }
  ];

  for (const counts of cases) {
    const tsVal = loadController(false).sortedCounts(counts);
    const rustVal = loadController(true).sortedCounts(counts);
    assert.deepStrictEqual(
      rustVal,
      tsVal,
      `sortedCounts parity mismatch for ${JSON.stringify(counts)}`
    );
  }

  console.log('autonomy_sorted_counts_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_sorted_counts_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

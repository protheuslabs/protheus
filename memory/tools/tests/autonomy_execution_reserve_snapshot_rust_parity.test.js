#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_ENABLED = '1';
  process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_RATIO = '0.12';
  process.env.AUTONOMY_BUDGET_EXECUTION_RESERVE_MIN_TOKENS = '600';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const cases = [
    { cap: 1000, used: 950 },
    { cap: 1000, used: 100 },
    { cap: 500, used: 700 },
    { cap: 0, used: 0 }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).executionReserveSnapshot(tc.cap, tc.used);
    const rustOut = loadController(true).executionReserveSnapshot(tc.cap, tc.used);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `executionReserveSnapshot parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_execution_reserve_snapshot_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execution_reserve_snapshot_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

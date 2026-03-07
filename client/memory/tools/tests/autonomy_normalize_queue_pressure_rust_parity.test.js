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
  const tsController = loadController(false);
  const rustController = loadController(true);

  const samples = [
    { pressure: 'critical', pending: 10, total: 12, pending_ratio: 0.83 },
    { pressure: 'warning', pending: 5, total: 20, pending_ratio: 0.25 },
    { pressure: 'normal', pending: 1, total: 10, pending_ratio: 0.1 },
    { pending: 0, total: 0, pending_ratio: null },
    { pending: 6, total: 7 }
  ];

  for (const [idx, sample] of samples.entries()) {
    const tsOut = tsController.normalizeQueuePressure(sample);
    const rustOut = rustController.normalizeQueuePressure(sample);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `normalizeQueuePressure parity mismatch sample ${idx + 1}: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
    );
  }

  console.log('autonomy_normalize_queue_pressure_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalize_queue_pressure_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

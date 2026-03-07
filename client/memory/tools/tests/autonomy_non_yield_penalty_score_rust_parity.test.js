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
  const rows = [
    [0.5, 0.25, 0.1, 0.2],
    [0.1, 0.3, 0.4, 0.0],
    [0.0, 0.0, 0.0, 1.0],
    [0.9, 0.8, 0.7, 0.6]
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.computeNonYieldPenaltyScore(row[0], row[1], row[2], row[3]);
    const rustOut = rustController.computeNonYieldPenaltyScore(row[0], row[1], row[2], row[3]);
    assert.strictEqual(
      rustOut,
      tsOut,
      `computeNonYieldPenaltyScore parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_non_yield_penalty_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_non_yield_penalty_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    [18.4, 2.718],
    [0.5, 0.25],
    [100, 100],
    [-1, -2]
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.computeCollectiveShadowAdjustments(row[0], row[1]);
    const rustOut = rustController.computeCollectiveShadowAdjustments(row[0], row[1]);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeCollectiveShadowAdjustments parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_collective_shadow_adjustments_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_collective_shadow_adjustments_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

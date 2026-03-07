#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled, highAccuracyMode) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT = '11';
  process.env.AUTONOMY_OPTIMIZATION_MIN_DELTA_PERCENT_HIGH_ACCURACY = '4';
  process.env.AUTONOMY_OPTIMIZATION_HIGH_ACCURACY_MODE = highAccuracyMode ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function runCase(highAccuracyMode) {
  const tsController = loadController(false, highAccuracyMode);
  const rustController = loadController(true, highAccuracyMode);
  const tsOut = tsController.optimizationMinDeltaPercent();
  const rustOut = rustController.optimizationMinDeltaPercent();
  assert.strictEqual(
    rustOut,
    tsOut,
    `optimizationMinDeltaPercent parity mismatch (highAccuracyMode=${highAccuracyMode}): ts=${tsOut} rust=${rustOut}`
  );
}

function run() {
  runCase(false);
  runCase(true);
  console.log('autonomy_optimization_min_delta_percent_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_optimization_min_delta_percent_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

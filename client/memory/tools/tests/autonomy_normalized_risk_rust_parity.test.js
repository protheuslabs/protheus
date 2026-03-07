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
  const samples = [undefined, null, '', 'HIGH', 'medium', 'low', 'critical'];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.normalizedRisk(sample);
    const rustOut = rustController.normalizedRisk(sample);
    assert.strictEqual(
      rustOut,
      tsOut,
      `normalizedRisk parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_normalized_risk_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalized_risk_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

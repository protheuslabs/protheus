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
  const samples = [
    undefined,
    null,
    '',
    'abc',
    -2,
    0,
    1,
    1.4,
    1.6,
    2,
    2.7,
    3,
    3.2,
    4,
    8
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.directiveTierWeight(sample);
    const rustOut = rustController.directiveTierWeight(sample);
    assert.strictEqual(
      rustOut,
      tsOut,
      `directiveTierWeight parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_directive_tier_weight_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_tier_weight_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

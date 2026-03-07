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
    { expected_impact: 'high' },
    { expected_impact: 'medium' },
    { expected_impact: 'low' },
    { expected_impact: '' },
    {}
  ];

  for (const proposal of cases) {
    const tsOut = loadController(false).impactWeight(proposal);
    const rustOut = loadController(true).impactWeight(proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `impactWeight parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_impact_weight_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_impact_weight_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

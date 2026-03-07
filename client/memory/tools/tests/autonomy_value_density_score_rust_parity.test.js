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
    { expectedValue: 60, estTokens: 500 },
    { expectedValue: 20, estTokens: 4000 },
    { expectedValue: 0, estTokens: 500 },
    { expectedValue: 120, estTokens: 20 },
    { expectedValue: null, estTokens: undefined }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).valueDensityScore(tc.expectedValue, tc.estTokens);
    const rustOut = loadController(true).valueDensityScore(tc.expectedValue, tc.estTokens);
    assert.strictEqual(
      rustOut,
      tsOut,
      `valueDensityScore parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_value_density_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_value_density_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

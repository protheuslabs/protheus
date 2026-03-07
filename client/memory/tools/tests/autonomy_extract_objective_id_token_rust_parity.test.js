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
    'T12_build_router',
    'objective: T8_fix_drift soon',
    'invalid token'
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.extractObjectiveIdToken(sample);
    const rustOut = rustController.extractObjectiveIdToken(sample);
    assert.strictEqual(
      rustOut,
      tsOut,
      `extractObjectiveIdToken parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_extract_objective_id_token_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_extract_objective_id_token_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

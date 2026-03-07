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

  const tsOut = tsController.defaultBacklogAutoscaleState();
  const rustOut = rustController.defaultBacklogAutoscaleState();

  assert.deepStrictEqual(
    rustOut,
    tsOut,
    `defaultBacklogAutoscaleState parity mismatch: ts=${JSON.stringify(tsOut)} rust=${JSON.stringify(rustOut)}`
  );

  console.log('autonomy_default_backlog_autoscale_state_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_default_backlog_autoscale_state_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

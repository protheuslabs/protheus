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
    {},
    { pressure: 'normal' },
    { pressure: 'warning' },
    { pressure: 'critical' }
  ];

  for (const queuePressure of cases) {
    const tsOut = loadController(false).qosLaneWeights(queuePressure);
    const rustOut = loadController(true).qosLaneWeights(queuePressure);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `qosLaneWeights parity mismatch for ${JSON.stringify(queuePressure)}`
    );
  }

  console.log('autonomy_qos_lane_weights_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_qos_lane_weights_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

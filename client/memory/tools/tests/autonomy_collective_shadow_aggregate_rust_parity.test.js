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
    [
      { kind: 'avoid', confidence: 0.8, score_impact: 10 },
      { kind: 'reinforce', confidence: 0.5, score_impact: 6 }
    ],
    [
      { kind: 'avoid', confidence: 0.2, score_impact: 5 },
      { kind: 'avoid', confidence: 0.9, score_impact: 3 }
    ],
    []
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.computeCollectiveShadowAggregate(row);
    const rustOut = rustController.computeCollectiveShadowAggregate(row);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeCollectiveShadowAggregate parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_collective_shadow_aggregate_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_collective_shadow_aggregate_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

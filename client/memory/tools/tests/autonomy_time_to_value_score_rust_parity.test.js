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
    { meta: { time_to_cash_hours: 24 }, expected_impact: 'high' },
    { meta: { time_to_cash_hours: 168 }, expected_impact: 'medium' },
    { meta: { time_to_cash_hours: -5 }, expected_impact: 'high' },
    { meta: {}, expected_impact: 'medium' },
    { meta: {}, expected_impact: 'low' }
  ];

  for (const proposal of cases) {
    const tsOut = loadController(false).timeToValueScore(proposal);
    const rustOut = loadController(true).timeToValueScore(proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `timeToValueScore parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_time_to_value_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_time_to_value_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

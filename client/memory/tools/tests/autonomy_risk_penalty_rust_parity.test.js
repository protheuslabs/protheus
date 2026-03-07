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
    { risk: 'high' },
    { risk: 'medium' },
    { risk: 'low' },
    { risk: '' },
    {}
  ];

  for (const proposal of cases) {
    const tsOut = loadController(false).riskPenalty(proposal);
    const rustOut = loadController(true).riskPenalty(proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `riskPenalty parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_risk_penalty_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_risk_penalty_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

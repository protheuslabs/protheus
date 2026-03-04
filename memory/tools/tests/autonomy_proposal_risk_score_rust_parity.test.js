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
    { meta: { risk_score: 61.8 }, risk: 'low' },
    { meta: { risk_score: '130' }, risk: 'low' },
    { meta: { risk_score: '-5' }, risk: 'high' },
    { meta: {}, risk: 'high' },
    { meta: {}, risk: 'medium' },
    { meta: {}, risk: 'weird' }
  ];

  for (const proposal of cases) {
    const tsOut = loadController(false).proposalRiskScore(proposal);
    const rustOut = loadController(true).proposalRiskScore(proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `proposalRiskScore parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_proposal_risk_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_risk_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

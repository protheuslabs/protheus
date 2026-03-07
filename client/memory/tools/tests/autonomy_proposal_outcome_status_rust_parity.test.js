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
    null,
    {},
    { outcome: '' },
    { outcome: ' SHIPPED ' },
    { outcome: 'no_change' }
  ];

  for (const overlay of cases) {
    const tsOut = loadController(false).proposalOutcomeStatus(overlay);
    const rustOut = loadController(true).proposalOutcomeStatus(overlay);
    assert.strictEqual(
      rustOut,
      tsOut,
      `proposalOutcomeStatus parity mismatch for ${JSON.stringify(overlay)}`
    );
  }

  console.log('autonomy_proposal_outcome_status_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_outcome_status_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

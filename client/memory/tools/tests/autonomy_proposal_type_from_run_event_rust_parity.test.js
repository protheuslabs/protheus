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
    { type: 'autonomy_run', proposal_type: 'Unknown', capability_key: 'proposal:directive' },
    { type: 'autonomy_run', proposal_type: '', capability_key: 'proposal:directive' },
    { type: 'autonomy_run', proposal_type: 'Optimization', capability_key: 'proposal:directive' },
    { type: 'autonomy_run', proposal_type: '', capability_key: 'tool:lint' },
    { type: 'other_event', proposal_type: 'directive', capability_key: 'proposal:directive' },
    { type: 'autonomy_run', proposal_type: '', capability_key: '' }
  ];

  for (const evt of cases) {
    const tsVal = loadController(false).runEventProposalType(evt);
    const rustVal = loadController(true).runEventProposalType(evt);
    assert.strictEqual(
      rustVal,
      tsVal,
      `runEventProposalType parity mismatch for ${evt.type}/${evt.proposal_type}/${evt.capability_key}`
    );
  }

  console.log('autonomy_proposal_type_from_run_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_type_from_run_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

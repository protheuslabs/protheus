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
    {
      evt: { type: 'autonomy_run', capability_key: 'deploy', proposal_type: 'ops' },
      proposalType: 'ops',
      capabilityKey: 'deploy'
    },
    {
      evt: { type: 'autonomy_run', capability_key: 'other', proposal_type: 'ops' },
      proposalType: 'ops',
      capabilityKey: 'deploy'
    },
    {
      evt: { type: 'autonomy_run', capability_key: '', proposal_type: 'ops' },
      proposalType: 'ops',
      capabilityKey: ''
    },
    {
      evt: { type: 'other', capability_key: 'deploy', proposal_type: 'ops' },
      proposalType: 'ops',
      capabilityKey: 'deploy'
    }
  ];

  for (const entry of cases) {
    const tsOut = loadController(false).executeConfidenceHistoryMatch(entry.evt, entry.proposalType, entry.capabilityKey);
    const rustOut = loadController(true).executeConfidenceHistoryMatch(entry.evt, entry.proposalType, entry.capabilityKey);
    assert.strictEqual(
      rustOut,
      tsOut,
      `executeConfidenceHistoryMatch parity mismatch for ${JSON.stringify(entry)}`
    );
  }

  console.log('autonomy_execute_confidence_history_match_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execute_confidence_history_match_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

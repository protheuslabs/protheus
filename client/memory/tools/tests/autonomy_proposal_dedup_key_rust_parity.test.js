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
      id: 'abc-1',
      type: 'ops_remediation',
      meta: { source_eye: 'github_release', remediation_kind: 'transport' }
    },
    {
      id: 'abc-2',
      type: 'feature_upgrade',
      meta: { source_eye: 'hn_frontpage' }
    },
    {
      id: 'abc-3',
      type: 'ops_remediation',
      meta: { source_eye: 'unknown_eye' }
    },
    {
      id: '',
      type: '',
      meta: {}
    }
  ];

  for (const proposal of cases) {
    const tsOut = loadController(false).proposalDedupKey(proposal);
    const rustOut = loadController(true).proposalDedupKey(proposal);
    assert.strictEqual(
      rustOut,
      tsOut,
      `proposalDedupKey parity mismatch for ${JSON.stringify(proposal)}`
    );
  }

  console.log('autonomy_proposal_dedup_key_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_dedup_key_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

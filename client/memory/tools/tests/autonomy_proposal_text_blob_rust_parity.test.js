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
    {
      title: 'Fix Drift',
      summary: 'Improve safety',
      suggested_next_command: 'run checks',
      notes: 'urgent',
      evidence: [{ evidence_ref: 'ref://a', path: 'client/docs/a.md', title: 'Doc A' }]
    },
    {
      title: 'Refactor',
      summary: null,
      suggested_command: 'npm test',
      notes: '',
      evidence: []
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of rows) {
    const tsOut = tsController.proposalTextBlob(row);
    const rustOut = rustController.proposalTextBlob(row);
    assert.strictEqual(
      rustOut,
      tsOut,
      `proposalTextBlob parity mismatch for ${JSON.stringify(row)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_proposal_text_blob_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_text_blob_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

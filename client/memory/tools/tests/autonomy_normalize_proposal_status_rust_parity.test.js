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
    { raw: null, fallback: 'pending' },
    { raw: '', fallback: 'pending' },
    { raw: 'unknown', fallback: 'pending' },
    { raw: 'new', fallback: '' },
    { raw: 'queued', fallback: 'accepted' },
    { raw: 'open', fallback: 'admitted' },
    { raw: 'admitted', fallback: 'pending' },
    { raw: 'closed_won', fallback: 'pending' },
    { raw: 'won', fallback: 'pending' },
    { raw: 'verified', fallback: 'pending' },
    { raw: ' paid ', fallback: 'pending' },
    { raw: 'rejected', fallback: 'pending' }
  ];

  for (const entry of cases) {
    const tsOut = loadController(false).normalizeStoredProposalStatus(entry.raw, entry.fallback);
    const rustOut = loadController(true).normalizeStoredProposalStatus(entry.raw, entry.fallback);
    assert.strictEqual(
      rustOut,
      tsOut,
      `normalizeStoredProposalStatus parity mismatch for ${JSON.stringify(entry)}`
    );
  }

  console.log('autonomy_normalize_proposal_status_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalize_proposal_status_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

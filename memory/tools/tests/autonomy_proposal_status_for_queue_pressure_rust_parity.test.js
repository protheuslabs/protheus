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
    { proposal: { status: 'closed_won' }, overlay: null },
    { proposal: { status: 'rejected' }, overlay: null },
    { proposal: { status: 'queued' }, overlay: null },
    { proposal: { status: 'pending' }, overlay: { decision: 'accept' } },
    { proposal: { status: 'closed' }, overlay: { decision: 'reject' } },
    { proposal: { status: 'accepted' }, overlay: { decision: 'park' } },
    { proposal: { status: 'accepted' }, overlay: { decision: 'unknown' } },
    { proposal: {}, overlay: {} }
  ];

  for (const entry of cases) {
    const tsOut = loadController(false).proposalStatusForQueuePressure(entry.proposal, entry.overlay);
    const rustOut = loadController(true).proposalStatusForQueuePressure(entry.proposal, entry.overlay);
    assert.strictEqual(
      rustOut,
      tsOut,
      `proposalStatusForQueuePressure parity mismatch for ${JSON.stringify(entry)}`
    );
  }

  console.log('autonomy_proposal_status_for_queue_pressure_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_status_for_queue_pressure_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_QUEUE_UNDERFLOW_BACKFILL_MAX = '2';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const cases = [
    { status: 'accepted', overlay: { outcome: '' } },
    { status: 'accepted', overlay: { outcome: ' shipped ' } },
    { status: 'accepted', overlay: null },
    { status: 'pending', overlay: { outcome: '' } },
    { status: '', overlay: { outcome: '' } }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).canQueueUnderflowBackfill(tc.status, tc.overlay);
    const rustOut = loadController(true).canQueueUnderflowBackfill(tc.status, tc.overlay);
    assert.strictEqual(
      rustOut,
      tsOut,
      `canQueueUnderflowBackfill parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_can_queue_underflow_backfill_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_can_queue_underflow_backfill_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_QOS_EXPLORE_MAX_SHARE = '0.35';
  process.env.AUTONOMY_QOS_QUARANTINE_MAX_SHARE = '0.2';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const cases = [
    { lane: 'explore', usage: { explore: 4, quarantine: 1 }, executedCount: 10 },
    { lane: 'explore', usage: { explore: 2, quarantine: 1 }, executedCount: 10 },
    { lane: 'quarantine', usage: { explore: 1, quarantine: 2 }, executedCount: 10 },
    { lane: 'standard', usage: { explore: 8, quarantine: 8 }, executedCount: 10 },
    { lane: 'explore', usage: { explore: 1, quarantine: 1 }, executedCount: 0 }
  ];

  for (const tc of cases) {
    const tsOut = loadController(false).qosLaneShareCapExceeded(tc.lane, tc.usage, tc.executedCount);
    const rustOut = loadController(true).qosLaneShareCapExceeded(tc.lane, tc.usage, tc.executedCount);
    assert.strictEqual(
      rustOut,
      tsOut,
      `qosLaneShareCapExceeded parity mismatch for ${JSON.stringify(tc)}`
    );
  }

  console.log('autonomy_qos_lane_share_cap_exceeded_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_qos_lane_share_cap_exceeded_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

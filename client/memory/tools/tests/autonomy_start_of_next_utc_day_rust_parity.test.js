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
  const cases = ['2026-03-03', '2024-02-29', 'bad-date', ''];
  for (const dateStr of cases) {
    const tsOut = loadController(false).startOfNextUtcDay(dateStr);
    const rustOut = loadController(true).startOfNextUtcDay(dateStr);
    assert.strictEqual(
      rustOut,
      tsOut,
      `startOfNextUtcDay parity mismatch for ${JSON.stringify(dateStr)}`
    );
  }

  console.log('autonomy_start_of_next_utc_day_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_start_of_next_utc_day_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

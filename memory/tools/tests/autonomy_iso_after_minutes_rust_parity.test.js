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
  const nowMs = 1772539200000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const cases = [30, 0, -10, Number.NaN];
    for (const minutes of cases) {
      const tsOut = loadController(false).isoAfterMinutes(minutes);
      const rustOut = loadController(true).isoAfterMinutes(minutes);
      assert.strictEqual(
        rustOut,
        tsOut,
        `isoAfterMinutes parity mismatch for ${String(minutes)}`
      );
    }
  } finally {
    Date.now = originalDateNow;
  }

  console.log('autonomy_iso_after_minutes_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_iso_after_minutes_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

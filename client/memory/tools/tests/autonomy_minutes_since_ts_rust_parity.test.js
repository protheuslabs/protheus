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
  const nowMs = 1772503200000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const cases = [
      null,
      '',
      'not-a-date',
      '2026-03-03T11:00:00.000Z',
      '2026-03-03T13:00:00.000Z'
    ];

    for (const ts of cases) {
      const tsOut = loadController(false).minutesSinceTs(ts);
      const rustOut = loadController(true).minutesSinceTs(ts);
      if (tsOut == null || rustOut == null) {
        assert.strictEqual(rustOut, tsOut, `minutesSinceTs null parity mismatch for ${ts}`);
      } else {
        assert.ok(
          Math.abs(Number(rustOut) - Number(tsOut)) < 1e-9,
          `minutesSinceTs parity mismatch for ${ts}: rust=${rustOut} ts=${tsOut}`
        );
      }
    }
  } finally {
    Date.now = originalDateNow;
  }

  console.log('autonomy_minutes_since_ts_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_minutes_since_ts_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

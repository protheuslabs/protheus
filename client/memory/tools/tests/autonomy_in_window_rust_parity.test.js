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
    { ts: '2026-03-03T12:00:00.000Z', endDateStr: '2026-03-03', days: 1 },
    { ts: '2026-03-03T00:00:00.000Z', endDateStr: '2026-03-03', days: 1 },
    { ts: '2026-03-02T23:59:59.000Z', endDateStr: '2026-03-03', days: 1 },
    { ts: '2026-03-01T12:00:00.000Z', endDateStr: '2026-03-03', days: 3 },
    { ts: 'bad-ts', endDateStr: '2026-03-03', days: 2 },
    { ts: '2026-03-03T12:00:00.000Z', endDateStr: 'bad-date', days: 2 }
  ];

  for (const entry of cases) {
    const tsOut = loadController(false).inWindow(entry.ts, entry.endDateStr, entry.days);
    const rustOut = loadController(true).inWindow(entry.ts, entry.endDateStr, entry.days);
    assert.strictEqual(
      rustOut,
      tsOut,
      `inWindow parity mismatch for ${JSON.stringify(entry)}`
    );
  }

  console.log('autonomy_in_window_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_in_window_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

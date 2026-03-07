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
    { endDateStr: '2026-03-03', days: 3 },
    { endDateStr: '2026-03-03', days: 2.7 },
    { endDateStr: '2026-03-03', days: 0 },
    { endDateStr: 'bad-date', days: 3 },
    { endDateStr: '', days: 3 }
  ];

  for (const entry of cases) {
    const tsOut = loadController(false).dateWindow(entry.endDateStr, entry.days);
    const rustOut = loadController(true).dateWindow(entry.endDateStr, entry.days);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `dateWindow parity mismatch for ${JSON.stringify(entry)}`
    );
  }

  console.log('autonomy_date_window_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_date_window_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

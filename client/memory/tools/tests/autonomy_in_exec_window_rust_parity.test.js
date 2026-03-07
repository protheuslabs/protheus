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
  const start = Date.parse('2026-03-04T10:00:00.000Z');
  const end = Date.parse('2026-03-04T10:30:00.000Z');
  const window = { start_ms: start, end_ms: end };

  const samples = [
    { label: 'inside window', ts: '2026-03-04T10:10:00.000Z', window },
    { label: 'before window', ts: '2026-03-04T09:00:00.000Z', window },
    { label: 'after window', ts: '2026-03-04T11:30:00.000Z', window },
    { label: 'invalid ts', ts: 'not-a-date', window },
    { label: 'missing window', ts: '2026-03-04T10:10:00.000Z', window: null }
  ];

  for (const sample of samples) {
    const tsOut = loadController(false).inExecWindow(sample.ts, sample.window);
    const rustOut = loadController(true).inExecWindow(sample.ts, sample.window);
    assert.strictEqual(
      rustOut,
      tsOut,
      `inExecWindow parity mismatch (${sample.label})`
    );
  }

  console.log('autonomy_in_exec_window_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_in_exec_window_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

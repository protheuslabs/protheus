#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);
  const samples = [
    [5, 2, null],
    ['x', 3, null],
    ['x', 'y', 9],
    ['x', 'y', null],
    [null, 2, 7]
  ];

  for (const [primary, fallback, nullFallback] of samples) {
    const tsOut = ts.coalesceNumeric(primary, fallback, nullFallback);
    const rustOut = rust.coalesceNumeric(primary, fallback, nullFallback);
    assert.deepStrictEqual(rustOut, tsOut, `coalesceNumeric mismatch for sample=${JSON.stringify([primary,fallback,nullFallback])}`);
  }

  console.log('autonomy_coalesce_numeric_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_coalesce_numeric_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    [5, 0, 10],
    [-3, 0, 10],
    [22, 0, 10],
    [Number.NaN, 2, 8]
  ];

  for (const [v, min, max] of samples) {
    const tsOut = ts.clampNumber(v, min, max);
    const rustOut = rust.clampNumber(v, min, max);
    assert.deepStrictEqual(rustOut, tsOut, `clampNumber mismatch for sample=${JSON.stringify([v,min,max])}`);
  }

  console.log('autonomy_clamp_number_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_clamp_number_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

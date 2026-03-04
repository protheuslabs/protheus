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

function normalize(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    key: String(row.key || ''),
    bias: Number(row.bias || 0),
    total: Number(row.total || 0),
    shipped: Number(row.shipped || 0),
    no_change: Number(row.no_change || 0),
    reverted: Number(row.reverted || 0)
  }));
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const map = {
    alpha: { bias: 2, total: 10, shipped: 5, no_change: 3, reverted: 2 },
    beta: { bias: -4, total: 3, shipped: 1, no_change: 1, reverted: 1 },
    gamma: { bias: 1, total: 8, shipped: 4, no_change: 3, reverted: 1 }
  };

  const tsOut = normalize(ts.summarizeTopBiases(map, 3));
  const rustOut = normalize(rust.summarizeTopBiases(map, 3));
  assert.deepStrictEqual(rustOut, tsOut, 'summarizeTopBiases mismatch');

  console.log('autonomy_top_biases_summary_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_top_biases_summary_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

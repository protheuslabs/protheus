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

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    applies: row.applies === true,
    pass: row.pass === true,
    reason: row.reason == null ? null : String(row.reason),
    delta_percent: row.delta_percent == null ? null : Number(Number(row.delta_percent).toFixed(3)),
    delta_source: row.delta_source == null ? null : String(row.delta_source),
    min_delta_percent: Number(Number(row.min_delta_percent || 0).toFixed(3)),
    require_delta: row.require_delta === true,
    mode: String(row.mode || ''),
    risk: String(row.risk || '')
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = {
    type: 'optimization',
    title: 'Improve throughput by 14% with index tuning',
    meta: {
      expected_delta_percent: 14
    },
    risk: 'medium'
  };

  const tsOut = normalize(ts.assessOptimizationGoodEnough(proposal, 'medium'));
  const rustOut = normalize(rust.assessOptimizationGoodEnough(proposal, 'medium'));
  assert.deepStrictEqual(rustOut, tsOut, 'assessOptimizationGoodEnough mismatch');

  console.log('autonomy_optimization_good_enough_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_optimization_good_enough_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

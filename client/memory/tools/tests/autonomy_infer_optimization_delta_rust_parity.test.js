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
  const delta = row.delta_percent == null ? null : Number(Number(row.delta_percent).toFixed(3));
  return {
    delta_percent: delta,
    delta_source: row.delta_source == null ? null : String(row.delta_source)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = {
    title: 'Optimize queue throughput',
    summary: 'Expect 18% throughput gain after schema tuning',
    meta: {
      expected_delta_percent: 18
    },
    validation: ['verify <= 2% drift']
  };

  const tsOut = normalize(ts.inferOptimizationDeltaForProposal(proposal));
  const rustOut = normalize(rust.inferOptimizationDeltaForProposal(proposal));
  assert.deepStrictEqual(rustOut, tsOut, 'inferOptimizationDeltaForProposal mismatch');

  console.log('autonomy_infer_optimization_delta_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_infer_optimization_delta_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
  const sources = [
    { metrics: { score: 42 } },
    { metrics: { score: 7 } }
  ];
  const paths = ['metrics.missing', 'metrics.score'];

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = ts.readFirstNumericMetric(sources, paths);
  const rustOut = rust.readFirstNumericMetric(sources, paths);

  assert.deepStrictEqual(rustOut, tsOut, 'readFirstNumericMetric mismatch');
  console.log('autonomy_read_first_numeric_metric_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_read_first_numeric_metric_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
    { expected_impact: 'high' },
    { expected_impact: 'medium', meta: { expected_value_score: 63 } },
    { expected_impact: 'low', meta: { expected_value_usd: 1200 } }
  ];

  for (const sample of samples) {
    assert.strictEqual(
      Number(rust.expectedValueScore(sample)),
      Number(ts.expectedValueScore(sample)),
      `expectedValueScore mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_expected_value_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_expected_value_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

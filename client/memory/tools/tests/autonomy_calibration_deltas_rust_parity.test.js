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
    min_signal_quality: Number(row.min_signal_quality || 0),
    min_sensory_signal_score: Number(row.min_sensory_signal_score || 0),
    min_sensory_relevance_score: Number(row.min_sensory_relevance_score || 0),
    min_directive_fit: Number(row.min_directive_fit || 0),
    min_actionability_score: Number(row.min_actionability_score || 0),
    min_eye_score_ema: Number(row.min_eye_score_ema || 0)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const samples = [
    { executedCount: 0, shippedRate: 0, noChangeRate: 0, revertedRate: 0, exhausted: 0 },
    { executedCount: 12, shippedRate: 0.52, noChangeRate: 0.62, revertedRate: 0.18, exhausted: 3 },
    { executedCount: 8, shippedRate: 0.05, noChangeRate: 0.7, revertedRate: 0.05, exhausted: 4 },
    { executedCount: 5, shippedRate: 0.3, noChangeRate: 0.3, revertedRate: 0.1, exhausted: 3 }
  ];

  for (const sample of samples) {
    const tsOut = normalize(ts.computeCalibrationDeltas(sample));
    const rustOut = normalize(rust.computeCalibrationDeltas(sample));
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `computeCalibrationDeltas mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_calibration_deltas_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_calibration_deltas_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

  const strategyOverride = {
    threshold_overrides: {
      min_signal_quality: 66,
      min_directive_fit: 44
    }
  };

  const tsOut = normalize(ts.baseThresholds(strategyOverride));
  const rustOut = normalize(rust.baseThresholds(strategyOverride));
  assert.deepStrictEqual(rustOut, tsOut, 'baseThresholds mismatch');

  console.log('autonomy_base_thresholds_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_base_thresholds_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

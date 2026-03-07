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

function makeCandidate(id, legacy, tritAdjusted, label, confidence) {
  return {
    proposal: { id },
    strategy_rank_adjusted: legacy,
    strategy_trit_shadow: {
      adjusted_score: tritAdjusted,
      belief: { label, confidence },
      top_sources: ['quality_gate', 'value_signal_gate']
    }
  };
}

function run() {
  const eligible = [
    makeCandidate('p-1', 92.0, 72.4, 'neutral', 0.41),
    makeCandidate('p-2', 80.2, 95.3, 'positive', 0.88),
    makeCandidate('p-3', 85.7, 88.8, 'positive', 0.74)
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  const tsOut = tsController.strategyTritShadowRankingSummary(eligible, 'p-1', 'qos_standard_legacy');
  const rustOut = rustController.strategyTritShadowRankingSummary(eligible, 'p-1', 'qos_standard_legacy');

  assert.deepStrictEqual(
    rustOut,
    tsOut,
    'strategyTritShadowRankingSummary parity mismatch'
  );

  console.log('autonomy_strategy_trit_shadow_ranking_summary_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_trit_shadow_ranking_summary_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

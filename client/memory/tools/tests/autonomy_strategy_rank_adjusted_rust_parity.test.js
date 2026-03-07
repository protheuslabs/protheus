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

function buildCandidate(idx) {
  return {
    strategy_rank: { score: 55 + (idx * 7.5) },
    directive_pulse: {
      score: 40 + (idx * 15),
      objective_allocation_score: 25 + (idx * 18)
    }
  };
}

function run() {
  const modes = ['canary_execute', 'standard_execute', 'execute', 'preview'];

  for (let i = 0; i < modes.length; i += 1) {
    const cand = buildCandidate(i);
    const mode = modes[i];

    const tsOut = loadController(false).strategyRankAdjustedForCandidate(cand, mode);
    const rustOut = loadController(true).strategyRankAdjustedForCandidate(cand, mode);

    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `strategyRankAdjustedForCandidate parity mismatch for mode=${mode}`
    );
  }

  console.log('autonomy_strategy_rank_adjusted_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_rank_adjusted_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

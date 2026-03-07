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

function run() {
  const cases = [
    { base: 68.75, bonusRaw: 12.345, bonusBlend: 0.4 },
    { base: 42.125, bonusRaw: 3.75, bonusBlend: 0.6 },
    { base: 90, bonusRaw: -1.5, bonusBlend: 0.35 },
    { base: 0, bonusRaw: 0, bonusBlend: 0.5 }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const row of cases) {
    const tsOut = tsController.strategyTritShadowAdjustedScore(row.base, row.bonusRaw, row.bonusBlend);
    const rustOut = rustController.strategyTritShadowAdjustedScore(row.base, row.bonusRaw, row.bonusBlend);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `strategyTritShadowAdjustedScore parity mismatch for ${JSON.stringify(row)}`
    );
  }

  console.log('autonomy_strategy_trit_shadow_adjusted_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_trit_shadow_adjusted_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

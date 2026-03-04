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
  const samples = [
    { raw: undefined, fallback: 3 },
    { raw: null, fallback: 3 },
    { raw: 'abc', fallback: 3 },
    { raw: 0, fallback: 3 },
    { raw: 1, fallback: 3 },
    { raw: 1.4, fallback: 3 },
    { raw: 1.6, fallback: 3 },
    { raw: 2.2, fallback: 3 },
    { raw: 99, fallback: 3 },
    { raw: undefined, fallback: 99 }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.normalizeDirectiveTier(sample.raw, sample.fallback);
    const rustOut = rustController.normalizeDirectiveTier(sample.raw, sample.fallback);
    assert.strictEqual(
      rustOut,
      tsOut,
      `normalizeDirectiveTier parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_normalize_directive_tier_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalize_directive_tier_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

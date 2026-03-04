#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const impactInputs = ['low', 'MEDIUM', 'high', 'critical', 'invalid', '', null];
  for (const input of impactInputs) {
    assert.strictEqual(
      rust.normalizeImpact(input),
      ts.normalizeImpact(input),
      `normalizeImpact mismatch for ${String(input)}`
    );
  }

  const modeInputs = ['test', 'live', 'TEST', 'prod', '', null];
  for (const input of modeInputs) {
    assert.strictEqual(
      rust.normalizeMode(input),
      ts.normalizeMode(input),
      `normalizeMode mismatch for ${String(input)}`
    );
  }

  const targetInputs = ['tactical', 'belief', 'identity', 'directive', 'constitution', 'unknown', '', null];
  for (const input of targetInputs) {
    assert.strictEqual(
      rust.normalizeTarget(input),
      ts.normalizeTarget(input),
      `normalizeTarget mismatch for ${String(input)}`
    );
  }

  const resultInputs = ['success', 'neutral', 'fail', 'destructive', 'invalid', '', null];
  for (const input of resultInputs) {
    assert.strictEqual(
      rust.normalizeResult(input),
      ts.normalizeResult(input),
      `normalizeResult mismatch for ${String(input)}`
    );
  }

  console.log('inversion_norm_primitives_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_norm_primitives_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

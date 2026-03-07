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
    { tier: 1, pulseCtx: { attempts_today: 0, tier_attempts_today: {} } },
    { tier: 2, pulseCtx: { attempts_today: 0, tier_attempts_today: { 2: 0 } } },
    { tier: 3, pulseCtx: { attempts_today: 0, tier_attempts_today: { 3: 0 } } },
    { tier: 1, pulseCtx: { attempts_today: 10, tier_attempts_today: { 1: 0 } } },
    { tier: 2, pulseCtx: { attempts_today: 10, tier_attempts_today: { 2: 1 } } },
    { tier: 2, pulseCtx: { attempts_today: 10, tier_attempts_today: { 2: 10 } } },
    { tier: 'abc', pulseCtx: { attempts_today: 5, tier_attempts_today: {} } }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.pulseTierCoverageBonus(sample.tier, sample.pulseCtx);
    const rustOut = rustController.pulseTierCoverageBonus(sample.tier, sample.pulseCtx);
    assert.strictEqual(
      rustOut,
      tsOut,
      `pulseTierCoverageBonus parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_directive_tier_coverage_bonus_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_tier_coverage_bonus_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

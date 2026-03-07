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
    {
      eligible: [
        { directive_pulse: { tier: 1 } },
        { directive_pulse: { tier: 1 } },
        { directive_pulse: { tier: 2 } }
      ],
      pulseCtx: {
        enabled: true,
        available: true,
        attempts_today: 10,
        tier_attempts_today: { 1: 0, 2: 1 }
      }
    },
    {
      eligible: [
        { directive_pulse: { tier: 2 } },
        { directive_pulse: { tier: 2 } }
      ],
      pulseCtx: {
        enabled: true,
        available: true,
        attempts_today: 8,
        tier_attempts_today: { 1: 4, 2: 0 }
      }
    },
    {
      eligible: [],
      pulseCtx: {
        enabled: true,
        available: true,
        attempts_today: 0,
        tier_attempts_today: {}
      }
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.directiveTierReservationNeed(sample.eligible, sample.pulseCtx);
    const rustOut = rustController.directiveTierReservationNeed(sample.eligible, sample.pulseCtx);
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `directiveTierReservationNeed parity mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('autonomy_directive_tier_reservation_need_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_directive_tier_reservation_need_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

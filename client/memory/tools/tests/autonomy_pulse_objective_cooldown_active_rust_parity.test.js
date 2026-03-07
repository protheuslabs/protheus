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

function isoHoursAgo(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function run() {
  const samples = [
    {
      stat: { no_progress_streak: 4, last_attempt_ts: isoHoursAgo(1) },
      pulseCtx: { no_progress_limit: 3, cooldown_hours: 6 }
    },
    {
      stat: { no_progress_streak: 4, last_attempt_ts: isoHoursAgo(12) },
      pulseCtx: { no_progress_limit: 3, cooldown_hours: 6 }
    },
    {
      stat: { no_progress_streak: 1, last_attempt_ts: isoHoursAgo(1) },
      pulseCtx: { no_progress_limit: 3, cooldown_hours: 6 }
    },
    {
      stat: { no_progress_streak: 5, last_attempt_ts: 'not-a-date' },
      pulseCtx: { no_progress_limit: 3, cooldown_hours: 6 }
    }
  ];

  const tsController = loadController(false);
  const rustController = loadController(true);

  for (const sample of samples) {
    const tsOut = tsController.pulseObjectiveCooldownActive(sample.stat, sample.pulseCtx);
    const rustOut = rustController.pulseObjectiveCooldownActive(sample.stat, sample.pulseCtx);
    assert.strictEqual(
      rustOut,
      tsOut,
      `pulseObjectiveCooldownActive parity mismatch for ${JSON.stringify(sample)}: ts=${tsOut} rust=${rustOut}`
    );
  }

  console.log('autonomy_pulse_objective_cooldown_active_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_pulse_objective_cooldown_active_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

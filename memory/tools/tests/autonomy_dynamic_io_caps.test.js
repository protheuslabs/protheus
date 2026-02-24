#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  const baseInput = {
    executionMode: 'execute',
    baseDailyCap: 6,
    baseCanaryCap: null,
    attemptsToday: 4,
    noProgressStreak: 0,
    executedNoProgressStreak: 0,
    gateExhaustionStreak: 0,
    shippedToday: 0,
    admission: { total: 24, eligible: 8, blocked: 16 },
    policyHoldPressure: { rate: 0, samples: 0, level: 'normal', applicable: false },
    queuePressure: {
      pressure: 'warning',
      total: 120,
      pending: 42,
      pending_ratio: 0.35,
      warn_ratio: 0.3,
      critical_ratio: 0.45,
      warn_count: 45,
      critical_count: 80
    },
    candidatePoolSize: 24
  };

  const warningCaps = controller.adaptiveExecutionCaps(baseInput);
  assert.strictEqual(warningCaps.low_yield, true, 'warning queue pressure should mark low-yield state');
  assert.ok(warningCaps.daily_runs_cap < 6, 'warning queue pressure should downshift output cap');
  assert.ok(
    Number.isFinite(Number(warningCaps.input_candidates_cap)) && Number(warningCaps.input_candidates_cap) < 24,
    'warning queue pressure should cap input candidates'
  );
  assert.ok(
    Array.isArray(warningCaps.reasons) && warningCaps.reasons.includes('downshift_queue_backlog_warning'),
    'warning queue pressure should emit backlog downshift reason'
  );

  const spawnResetCaps = controller.adaptiveExecutionCaps({
    ...baseInput,
    spawnCapacityBoost: {
      enabled: true,
      active: true,
      lookback_minutes: 180,
      min_granted_cells: 1,
      grant_count: 1,
      granted_cells: 2,
      latest_ts: new Date().toISOString()
    }
  });
  assert.strictEqual(spawnResetCaps.daily_runs_cap, 6, 'spawn capacity boost should reset output cap to baseline');
  assert.strictEqual(spawnResetCaps.input_candidates_cap, null, 'spawn capacity boost should clear input cap');
  assert.strictEqual(spawnResetCaps.spawn_reset_active, true, 'spawn reset flag should be exposed');
  assert.ok(
    Array.isArray(spawnResetCaps.reasons) && spawnResetCaps.reasons.includes('reset_caps_spawn_capacity'),
    'spawn reset should emit reset reason'
  );

  const criticalCaps = controller.adaptiveExecutionCaps({
    ...baseInput,
    queuePressure: {
      pressure: 'critical',
      total: 120,
      pending: 95,
      pending_ratio: 0.791667,
      warn_ratio: 0.3,
      critical_ratio: 0.45,
      warn_count: 45,
      critical_count: 80
    }
  });
  assert.ok(
    criticalCaps.daily_runs_cap <= warningCaps.daily_runs_cap,
    'critical queue pressure should be at least as restrictive as warning pressure'
  );
  assert.ok(
    Number(criticalCaps.input_candidates_cap || 0) <= Number(warningCaps.input_candidates_cap || 0),
    'critical queue pressure should enforce a tighter input cap'
  );

  console.log('autonomy_dynamic_io_caps.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_dynamic_io_caps.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

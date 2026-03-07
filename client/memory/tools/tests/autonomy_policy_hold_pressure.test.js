#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function isoMinutesAgo(mins) {
  return new Date(Date.now() - (Math.max(0, Number(mins || 0)) * 60000)).toISOString();
}

function holdEvent(result, minsAgo) {
  return {
    ts: isoMinutesAgo(minsAgo),
    type: 'autonomy_run',
    result,
    policy_hold: true
  };
}

function attemptEvent(result, minsAgo) {
  return {
    ts: isoMinutesAgo(minsAgo),
    type: 'autonomy_run',
    result
  };
}

function run() {
  const sparse = controller.policyHoldPressureSnapshot([
    attemptEvent('executed', 5),
    attemptEvent('init_gate_stub', 4),
    holdEvent('no_candidates_policy_daily_cap', 3)
  ], {
    min_samples: 6,
    window_hours: 24
  });
  assert.strictEqual(sparse.applicable, false, 'snapshot should remain non-applicable under min sample floor');
  assert.strictEqual(sparse.level, 'normal', 'snapshot should remain normal when sample floor not met');

  const hard = controller.policyHoldPressureSnapshot([
    holdEvent('no_candidates_policy_daily_cap', 11),
    holdEvent('stop_init_gate_budget_autopause', 10),
    holdEvent('score_only_fallback_low_execution_confidence', 9),
    holdEvent('no_candidates_policy_canary_cap', 8),
    holdEvent('no_candidates_policy_unchanged_state', 7),
    attemptEvent('stop_init_gate_quality_exhausted', 6),
    attemptEvent('executed', 5),
    attemptEvent('init_gate_stub', 4),
    attemptEvent('stop_repeat_gate_candidate_exhausted', 3),
    attemptEvent('executed', 2)
  ], {
    min_samples: 6,
    window_hours: 24
  });
  assert.strictEqual(hard.applicable, true, 'snapshot should become applicable over sample floor');
  assert.strictEqual(hard.level, 'hard', 'snapshot should classify hard pressure at >= hard-rate');
  assert.ok(hard.rate >= 0.4, 'hard snapshot should exceed default hard rate');

  const hardCooldown = controller.policyHoldCooldownMinutesForPressure(15, hard);
  assert.ok(hardCooldown >= 60, 'hard pressure should escalate policy-hold cooldown above baseline');

  const caps = controller.adaptiveExecutionCaps({
    executionMode: 'execute',
    baseDailyCap: 4,
    baseCanaryCap: null,
    attemptsToday: 8,
    noProgressStreak: 0,
    executedNoProgressStreak: 0,
    gateExhaustionStreak: 0,
    shippedToday: 1,
    admission: { total: 12, eligible: 8, blocked: 4 },
    policyHoldPressure: hard
  });
  assert.strictEqual(caps.daily_runs_cap, 1, 'hard policy-hold pressure should hard-downshift daily cap to 1');
  assert.ok(Array.isArray(caps.reasons) && caps.reasons.includes('downshift_policy_hold_hard'), 'hard downshift reason should be emitted');
  assert.strictEqual(caps.high_yield, false, 'high-yield upshift must be suppressed under hold pressure');

  console.log('autonomy_policy_hold_pressure.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_pressure.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

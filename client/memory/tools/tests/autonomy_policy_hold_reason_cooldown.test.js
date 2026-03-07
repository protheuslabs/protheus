#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_HARD_MINUTES = '61';
process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_WARN_MINUTES = '31';
process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_CAP_MINUTES = '240';
process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_MANUAL_REVIEW_MINUTES = '95';
process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_UNCHANGED_STATE_MINUTES = '105';
process.env.AUTONOMY_POLICY_HOLD_COOLDOWN_UNTIL_NEXT_DAY_CAPS = '0';
process.env.AUTONOMY_READINESS_RETRY_COOLDOWN_HOURS = '11';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function cooldown(result, opts = {}) {
  const pressure = opts.pressure || { applicable: true, level: 'normal' };
  const baseMinutes = Number.isFinite(Number(opts.baseMinutes)) ? Number(opts.baseMinutes) : 12;
  const lastRun = typeof result === 'string' ? { result } : {};
  return controller.policyHoldCooldownMinutesForResult(baseMinutes, pressure, lastRun);
}

function run() {
  assert.strictEqual(
    cooldown('no_candidates_policy_daily_cap'),
    240,
    'daily-cap hold should use cap cooldown override'
  );
  assert.strictEqual(
    cooldown('no_candidates_policy_canary_cap'),
    240,
    'canary-cap hold should use cap cooldown override'
  );
  assert.strictEqual(
    cooldown('no_candidates_policy_manual_review_pending'),
    95,
    'manual-review hold should use manual-review cooldown override'
  );
  assert.strictEqual(
    cooldown('stop_repeat_gate_human_escalation_pending'),
    95,
    'human-escalation hold should use manual-review cooldown override'
  );
  assert.strictEqual(
    cooldown('no_candidates_policy_unchanged_state'),
    105,
    'unchanged-state hold should use unchanged-state cooldown override'
  );
  assert.strictEqual(
    cooldown('stop_init_gate_readiness'),
    660,
    'readiness hold should use readiness retry cooldown hours'
  );
  assert.strictEqual(
    cooldown('executed', { pressure: { applicable: true, level: 'hard' }, baseMinutes: 5 }),
    61,
    'non-special results should still honor pressure cooldown escalation'
  );
  assert.strictEqual(
    cooldown('executed', { pressure: { applicable: true, level: 'normal' }, baseMinutes: 17 }),
    17,
    'non-special results should fall back to base cooldown when no pressure escalation applies'
  );

  console.log('autonomy_policy_hold_reason_cooldown.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_policy_hold_reason_cooldown.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

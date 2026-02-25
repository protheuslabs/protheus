#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-stage-'));
  const policyPath = path.join(tmp, 'config', 'trit_shadow_policy.json');
  const budgetPath = path.join(tmp, 'state', 'trit_shadow_influence_budget.json');
  const guardPath = path.join(tmp, 'state', 'trit_shadow_influence_guard.json');
  writeJson(policyPath, {
    version: '1.0',
    trust: {
      enabled: true,
      default_source_trust: 1,
      source_trust_floor: 0.6,
      source_trust_ceiling: 1.5,
      freshness_half_life_hours: 72
    },
    semantics: {
      locked: true,
      neutral_on_missing: true,
      min_non_neutral_signals: 1,
      min_non_neutral_weight: 0.9,
      min_confidence_for_non_neutral: 0.3
    },
    adaptation: {
      enabled: true,
      cadence_days: 7,
      min_samples_per_source: 6,
      reward_step: 0.04,
      penalty_step: 0.06,
      max_delta_per_cycle: 0.08
    },
    influence: {
      stage: 3,
      min_confidence_stage2: 0.75,
      min_confidence_stage3: 0.85,
      max_overrides_per_day: 1,
      auto_disable_hours_on_regression: 24
    }
  });
  writeJson(guardPath, {
    schema_id: 'trit_shadow_influence_guard',
    disabled: false,
    reason: null,
    disabled_until: null
  });

  withEnv({
    AUTONOMY_TRIT_SHADOW_POLICY_PATH: policyPath,
    AUTONOMY_TRIT_SHADOW_INFLUENCE_BUDGET_PATH: budgetPath,
    AUTONOMY_TRIT_SHADOW_INFLUENCE_GUARD_PATH: guardPath
  }, () => {
    const strategyPath = path.join(ROOT, 'systems', 'autonomy', 'strategy_mode_governor.js');
    const driftPath = path.join(ROOT, 'systems', 'autonomy', 'drift_target_governor.js');
    delete require.cache[require.resolve(strategyPath)];
    delete require.cache[require.resolve(driftPath)];
    const strategyGov = require(strategyPath);
    const driftGov = require(driftPath);

    const influenceStrategy = strategyGov.tritShadowInfluenceDecision(
      {
        trit_shadow: {
          enabled: true,
          shadow_to_mode: 'execute',
          belief: { confidence: 0.9 }
        },
        readiness_effective: { ready_for_execute: true, ready_for_canary: true },
        canary: { ready_for_execute: true, preview_ready_for_canary: true, metrics: { quality_lock_active: true } },
        execute_freeze: { active: false },
        spc: { pass: true, hold_escalation: false },
        policy: { require_spc: true, canary_require_quality_lock_for_execute: true }
      },
      { to_mode: 'canary_execute' },
      JSON.parse(fs.readFileSync(policyPath, 'utf8')),
      3,
      { disabled: false },
      '2026-02-25'
    );
    assert.strictEqual(influenceStrategy.apply, true, 'stage 3 should allow bounded override');
    assert.strictEqual(influenceStrategy.override, true, 'override should be marked true');

    const influenceDrift = driftGov.driftTritShadowInfluenceDecision(
      'hold',
      {
        enabled: true,
        action: 'tighten',
        belief: { confidence: 0.9 }
      },
      {
        enough_samples: true,
        verified_pass: true,
        shipped_pass: true,
        adjustment_cooldown_met: true
      },
      JSON.parse(fs.readFileSync(policyPath, 'utf8')),
      2,
      { disabled: false },
      '2026-02-25'
    );
    assert.strictEqual(influenceDrift.apply, true, 'stage 2 should allow fill-gap action');
    assert.strictEqual(influenceDrift.override, false, 'fill-gap should not count as override');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_influence_stage.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_influence_stage.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

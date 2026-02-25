#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(ROOT, 'lib', 'trit_shadow_control.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-control-'));
  const policyPath = path.join(tmp, 'config', 'trit_shadow_policy.json');
  const trustPath = path.join(tmp, 'state', 'trit_shadow_trust_state.json');
  const budgetPath = path.join(tmp, 'state', 'trit_shadow_influence_budget.json');
  const guardPath = path.join(tmp, 'state', 'trit_shadow_influence_guard.json');
  const reportHistoryPath = path.join(tmp, 'state', 'autonomy', 'trit_shadow_reports', 'history.jsonl');
  const calibrationHistoryPath = path.join(tmp, 'state', 'autonomy', 'trit_shadow_calibration', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    influence: {
      stage: 3,
      min_confidence_stage2: 0.75,
      min_confidence_stage3: 0.85,
      max_overrides_per_day: 2,
      auto_disable_hours_on_regression: 4
    },
    trust: {
      enabled: true,
      default_source_trust: 1,
      source_trust_floor: 0.6,
      source_trust_ceiling: 1.5,
      freshness_half_life_hours: 72
    },
    adaptation: {
      enabled: true,
      cadence_days: 7,
      min_samples_per_source: 4,
      reward_step: 0.04,
      penalty_step: 0.05,
      max_delta_per_cycle: 0.08
    },
    semantics: {
      locked: true,
      neutral_on_missing: true,
      min_non_neutral_signals: 1,
      min_non_neutral_weight: 0.9,
      min_confidence_for_non_neutral: 0.3
    },
    influence: {
      stage: 0,
      min_confidence_stage2: 0.75,
      min_confidence_stage3: 0.85,
      max_overrides_per_day: 2,
      auto_disable_hours_on_regression: 4,
      auto_stage: {
        enabled: true,
        mode: 'floor',
        stage2: {
          consecutive_reports: 2,
          min_decisions: 5,
          max_divergence_rate: 0.1,
          min_calibration_events: 5,
          min_calibration_accuracy: 0.5,
          max_calibration_ece: 0.4,
          require_success_criteria_pass: false,
          require_safety_pass: true,
          require_drift_non_increasing: true
        },
        stage3: {
          consecutive_reports: 3,
          min_decisions: 8,
          max_divergence_rate: 0.08,
          min_calibration_events: 8,
          min_calibration_accuracy: 0.6,
          max_calibration_ece: 0.3,
          require_success_criteria_pass: true,
          require_safety_pass: true,
          require_drift_non_increasing: true
        }
      }
    }
  });
  writeJson(trustPath, {
    schema_id: 'trit_shadow_trust_state',
    by_source: {
      spc_gate: { trust: 1.3, samples: 12, hit_rate: 0.75 }
    }
  });
  writeJson(reportHistoryPath, {});
  fs.writeFileSync(reportHistoryPath, [
    JSON.stringify({
      ok: true,
      type: 'trit_shadow_report',
      ts: '2026-02-24T00:00:00.000Z',
      summary: { total_decisions: 9, divergence_rate: 0.04 },
      success_criteria: { pass: true, checks: { safety_regressions: { pass: true }, drift_non_increasing: { pass: true } } }
    }),
    JSON.stringify({
      ok: true,
      type: 'trit_shadow_report',
      ts: '2026-02-25T00:00:00.000Z',
      summary: { total_decisions: 10, divergence_rate: 0.03 },
      success_criteria: { pass: true, checks: { safety_regressions: { pass: true }, drift_non_increasing: { pass: true } } }
    })
  ].join('\n') + '\n', 'utf8');
  fs.mkdirSync(path.dirname(calibrationHistoryPath), { recursive: true });
  fs.writeFileSync(calibrationHistoryPath, [
    JSON.stringify({
      ok: true,
      type: 'trit_shadow_replay_calibration',
      ts: '2026-02-25T00:10:00.000Z',
      date: '2026-02-25',
      summary: {
        total_events: 12,
        accuracy: 0.66,
        expected_calibration_error: 0.18
      }
    })
  ].join('\n') + '\n', 'utf8');

  withEnv({
    AUTONOMY_TRIT_SHADOW_POLICY_PATH: policyPath,
    AUTONOMY_TRIT_SHADOW_TRUST_STATE_PATH: trustPath,
    AUTONOMY_TRIT_SHADOW_INFLUENCE_BUDGET_PATH: budgetPath,
    AUTONOMY_TRIT_SHADOW_INFLUENCE_GUARD_PATH: guardPath,
    AUTONOMY_TRIT_SHADOW_REPORT_HISTORY_PATH: reportHistoryPath,
    AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH: calibrationHistoryPath
  }, () => {
    delete require.cache[require.resolve(MODULE_PATH)];
    const mod = require(MODULE_PATH);
    const policy = mod.loadTritShadowPolicy();
    const stageDecision = mod.resolveTritShadowStageDecision(policy);
    assert.strictEqual(Number(stageDecision.stage || 0), 2, 'auto stage should promote to stage 2 with threshold evidence');
    assert.strictEqual(mod.resolveTritShadowStage(policy), 2, 'resolved stage should follow auto-stage floor');
    const trustMap = mod.buildTritSourceTrustMap(mod.loadTritShadowTrustState(policy));
    assert.strictEqual(Number(trustMap.spc_gate || 0), 1.3, 'trust map should load source trust');

    const c1 = mod.canConsumeTritShadowOverride(policy, '2026-02-25');
    assert.strictEqual(c1.allowed, true, 'first override should be allowed');
    const u1 = mod.consumeTritShadowOverride('strategy_mode_governor', policy, '2026-02-25');
    assert.strictEqual(u1.consumed, true, 'first override should consume');
    const u2 = mod.consumeTritShadowOverride('strategy_mode_governor', policy, '2026-02-25');
    assert.strictEqual(u2.consumed, true, 'second override should consume');
    const c3 = mod.canConsumeTritShadowOverride(policy, '2026-02-25');
    assert.strictEqual(c3.allowed, false, 'third override should be blocked by daily budget');

    const guard = mod.applyInfluenceGuardFromShadowReport({
      ts: '2026-02-25T00:00:00.000Z',
      summary: {
        status: 'critical',
        gate: { enabled: true, pass: false, reason: 'divergence_rate_exceeds_limit' }
      }
    }, policy);
    assert.strictEqual(guard.disabled, true, 'failed gate should disable influence');
    const blocked = mod.isTritShadowInfluenceBlocked(guard, '2026-02-25T00:30:00.000Z');
    assert.strictEqual(blocked.blocked, true, 'guard should block within disable window');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_control.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_control.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

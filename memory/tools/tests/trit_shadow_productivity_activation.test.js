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

function writeJsonl(fp, rows) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
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
    for (const key of Object.keys(vars)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-productivity-'));
  const policyPath = path.join(tmp, 'config', 'trit_shadow_policy.json');
  const trustPath = path.join(tmp, 'state', 'trit_shadow_trust_state.json');
  const reportHistoryPath = path.join(tmp, 'state', 'autonomy', 'trit_shadow_reports', 'history.jsonl');
  const calibrationHistoryPath = path.join(tmp, 'state', 'autonomy', 'trit_shadow_calibration', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    influence: {
      stage: 0,
      activation: {
        enabled: true,
        report_window: 1,
        min_decisions: 1,
        max_divergence_rate: 0.2,
        require_success_criteria_pass: true,
        require_safety_pass: true,
        require_drift_non_increasing: true,
        calibration_window: 1,
        min_calibration_events: 5,
        min_calibration_accuracy: 0.8,
        max_calibration_ece: 0.2,
        min_source_samples: 5,
        min_source_hit_rate: 0.7,
        max_sources_below_threshold: 0,
        allow_if_no_source_data: false
      },
      auto_stage: {
        enabled: true,
        mode: 'floor',
        stage2: {
          consecutive_reports: 1,
          min_calibration_reports: 1,
          min_decisions: 1,
          max_divergence_rate: 0.2,
          min_calibration_events: 5,
          min_calibration_accuracy: 0.5,
          max_calibration_ece: 0.4,
          require_success_criteria_pass: true,
          require_safety_pass: true,
          require_drift_non_increasing: true,
          require_source_reliability: true
        },
        stage3: {
          consecutive_reports: 2,
          min_calibration_reports: 2,
          min_decisions: 3,
          max_divergence_rate: 0.1,
          min_calibration_events: 10,
          min_calibration_accuracy: 0.6,
          max_calibration_ece: 0.3,
          require_success_criteria_pass: true,
          require_safety_pass: true,
          require_drift_non_increasing: true,
          require_source_reliability: true
        }
      }
    },
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
    }
  });
  writeJson(trustPath, {
    schema_id: 'trit_shadow_trust_state',
    by_source: {}
  });
  writeJsonl(reportHistoryPath, [
    {
      ok: true,
      type: 'trit_shadow_report',
      ts: '2026-02-24T00:00:00.000Z',
      summary: {
        total_decisions: 12,
        divergence_rate: 0.02
      },
      success_criteria: {
        pass: true,
        checks: {
          safety_regressions: { pass: true },
          drift_non_increasing: { pass: true }
        }
      }
    }
  ]);
  writeJsonl(calibrationHistoryPath, [
    {
      ok: true,
      type: 'trit_shadow_replay_calibration',
      ts: '2026-02-24T00:10:00.000Z',
      date: '2026-02-24',
      summary: {
        total_events: 12,
        accuracy: 0.62,
        expected_calibration_error: 0.19
      },
      source_reliability: [
        { source: 'strategy_mode_governor', samples: 12, hit_rate: 0.61, reliability: 0.61 }
      ]
    }
  ]);

  withEnv({
    AUTONOMY_TRIT_SHADOW_POLICY_PATH: policyPath,
    AUTONOMY_TRIT_SHADOW_TRUST_STATE_PATH: trustPath,
    AUTONOMY_TRIT_SHADOW_REPORT_HISTORY_PATH: reportHistoryPath,
    AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH: calibrationHistoryPath
  }, () => {
    delete require.cache[require.resolve(MODULE_PATH)];
    const mod = require(MODULE_PATH);
    const policy = mod.loadTritShadowPolicy();
    const firstProductivity = mod.evaluateTritShadowProductivity(policy);
    assert.strictEqual(firstProductivity.active, false, 'weak calibration should block productivity activation');
    assert.ok(
      String(firstProductivity.reason || '').includes('activation_calibration_threshold_not_met')
      || String(firstProductivity.reason || '').includes('activation_source_reliability_not_met'),
      'productivity gate should fail for calibration/source reliability'
    );
    const firstStage = mod.resolveTritShadowStageDecision(policy);
    assert.strictEqual(Number(firstStage.stage || 0), 0, 'auto-stage should remain inactive while productivity gate fails');

    writeJsonl(calibrationHistoryPath, [
      {
        ok: true,
        type: 'trit_shadow_replay_calibration',
        ts: '2026-02-25T00:10:00.000Z',
        date: '2026-02-25',
        summary: {
          total_events: 16,
          accuracy: 0.86,
          expected_calibration_error: 0.1
        },
        source_reliability: [
          { source: 'strategy_mode_governor', samples: 10, hit_rate: 0.84, reliability: 0.84 }
        ]
      }
    ]);
    delete require.cache[require.resolve(MODULE_PATH)];
    const mod2 = require(MODULE_PATH);
    const policy2 = mod2.loadTritShadowPolicy();
    const secondProductivity = mod2.evaluateTritShadowProductivity(policy2);
    assert.strictEqual(secondProductivity.active, true, 'strong calibration should activate productivity gate');
    const secondStage = mod2.resolveTritShadowStageDecision(policy2);
    assert.strictEqual(Number(secondStage.stage || 0), 2, 'auto-stage should activate after productivity thresholds pass');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_productivity_activation.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_productivity_activation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


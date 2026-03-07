#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function run() {
  const outcomePolicyBefore = process.env.OUTCOME_FITNESS_POLICY_PATH;
  const tmpRoot = path.join(__dirname, 'temp_strategy_resolver');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);
  const strategyDir = path.join(tmpRoot, 'config', 'strategies');
  mkDir(strategyDir);

  writeJson(path.join(strategyDir, 'a_default.json'), {
    version: '1.0',
    id: 'default_general',
    status: 'active',
    objective: { primary: 'test objective' },
    campaigns: [
      {
        id: 'campaign_alpha',
        status: 'active',
        priority: 10,
        objective_id: 'T1_test',
        phases: [
          {
            id: 'phase_discover',
            order: 1,
            proposal_types: ['external_intel']
          },
          {
            id: 'phase_execute',
            order: 2,
            proposal_types: ['collector_remediation']
          }
        ]
      }
    ],
    generation_policy: { mode: 'hyper-creative' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'canary_execute', canary_daily_exec_limit: 2 },
    ranking_weights: {
      composite: 0.4,
      actionability: 0.2,
      directive_fit: 0.2,
      signal_quality: 0.1,
      expected_value: 0.1,
      risk_penalty: 0
    },
    value_currency_policy: {
      default_currency: 'delivery',
      currency_overrides: {
        revenue: {
          ranking_weights: {
            expected_value: 0.2,
            time_to_value: 0.08
          }
        },
        quality: {
          ranking_weights: {
            signal_quality: 0.24,
            risk_penalty: 0.1
          }
        }
      },
      objective_overrides: {
        T1_test: {
          primary_currency: 'revenue',
          ranking_weights: {
            directive_fit: 0.24,
            expected_value: 0.16
          }
        }
      }
    },
    budget_policy: { daily_runs_cap: 7, daily_token_cap: 9000, max_tokens_per_action: 1200 },
    exploration_policy: { fraction: 0.3, every_n: 4, min_eligible: 5 },
    threshold_overrides: { min_signal_quality: 63 }
  });
  writeJson(path.join(strategyDir, 'z_disabled.json'), {
    version: '1.0',
    id: 'archived_profile',
    status: 'disabled',
    risk_policy: { allowed_risks: ['medium'] }
  });
  writeJson(path.join(strategyDir, 'zz_invalid.json'), {
    version: '1.0',
    id: 'invalid_profile',
    status: 'disabled',
    objective: { primary: 'invalid profile for strict validation test' },
    risk_policy: { allowed_risks: ['critical', 'medium'], max_risk_per_action: 10 },
    admission_policy: {
      allowed_types: ['collector_remediation'],
      blocked_types: ['collector_remediation']
    },
    promotion_policy: {
      min_attempted: 1,
      min_shipped: 2
    }
  });

  process.env.OUTCOME_FITNESS_POLICY_PATH = path.join(tmpRoot, 'no_outcome_policy.json');

  const resolver = require('../../../lib/strategy_resolver.js');
  const listed = resolver.listStrategies({ dir: strategyDir });
  assert.strictEqual(listed.length, 3);
  assert.strictEqual(listed[0].id, 'archived_profile');
  assert.strictEqual(listed[1].id, 'default_general');
  assert.strictEqual(listed[2].id, 'invalid_profile');

  const active = resolver.loadActiveStrategy({ dir: strategyDir });
  assert.ok(active, 'active strategy expected');
  assert.strictEqual(active.id, 'default_general');
  assert.strictEqual(active.execution_policy.mode, 'canary_execute');
  assert.strictEqual(active.validation.strict_ok, true);
  assert.ok(!active.validation.warnings.includes('unknown_top_level_key:campaigns'));
  assert.ok(Array.isArray(active.campaigns), 'campaigns should be normalized');
  assert.strictEqual(active.campaigns.length, 1, 'expected one active campaign');
  assert.strictEqual(active.campaigns[0].phases.length, 2, 'expected two normalized phases');

  const requested = resolver.loadActiveStrategy({ dir: strategyDir, id: 'archived_profile' });
  assert.strictEqual(requested.id, 'archived_profile');

  const allowed = resolver.effectiveAllowedRisks(new Set(['low']), requested);
  assert.ok(allowed.has('medium'));
  assert.ok(!allowed.has('low'));

  const thresholds = resolver.applyThresholdOverrides(
    { min_signal_quality: 58, min_directive_fit: 40 },
    active
  );
  assert.strictEqual(thresholds.min_signal_quality, 63);
  assert.strictEqual(thresholds.min_directive_fit, 40);

  const mode = resolver.strategyExecutionMode(active, 'execute');
  assert.strictEqual(mode, 'canary_execute');
  assert.strictEqual(resolver.strategyGenerationMode(active, 'normal'), 'hyper-creative');
  assert.strictEqual(resolver.strategyCanaryDailyExecLimit(active, 1), 2);

  const promotion = resolver.strategyPromotionPolicy(active, { min_attempted: 10 });
  assert.strictEqual(promotion.min_days, 7);
  assert.strictEqual(promotion.min_attempted, 12);
  assert.strictEqual(promotion.min_success_criteria_receipts, 2);
  assert.strictEqual(promotion.min_objective_coverage, 0.25);
  assert.strictEqual(promotion.min_shipped, 1);
  assert.strictEqual(promotion.disable_legacy_fallback_after_quality_receipts, 10);
  assert.strictEqual(promotion.max_success_criteria_quality_insufficient_rate, 0.4);

  const riskCap = resolver.strategyMaxRiskPerAction(active, 50);
  assert.strictEqual(riskCap, 50);

  const duplicateWindow = resolver.strategyDuplicateWindowHours(active, 36);
  assert.strictEqual(duplicateWindow, 24);

  const caps = resolver.strategyBudgetCaps(active, { daily_runs_cap: 1, daily_token_cap: 1000 });
  assert.strictEqual(caps.daily_runs_cap, 7);
  assert.strictEqual(caps.daily_token_cap, 9000);
  assert.strictEqual(caps.max_tokens_per_action, 1200);

  const explore = resolver.strategyExplorationPolicy(active, {});
  assert.strictEqual(explore.every_n, 4);
  assert.strictEqual(explore.min_eligible, 5);
  assert.strictEqual(explore.fraction, 0.3);

  const weights = resolver.strategyRankingWeights(active);
  const wsum = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0);
  assert.ok(Math.abs(wsum - 1) < 0.0001, 'ranking weights should normalize to ~1');
  const contextRevenue = resolver.resolveStrategyRankingContext(active, {
    objective_id: 'T1_test',
    value_currency: 'revenue'
  });
  assert.ok(Array.isArray(contextRevenue.applied_overrides), 'contextual ranking should expose applied overrides');
  assert.ok(contextRevenue.applied_overrides.includes('objective:T1_test'));
  assert.ok(contextRevenue.applied_overrides.includes('currency:revenue'));
  assert.strictEqual(contextRevenue.value_currency, 'revenue');
  const contextWeightsSum = Object.values(contextRevenue.weights).reduce((a, b) => a + Number(b || 0), 0);
  assert.ok(Math.abs(contextWeightsSum - 1) < 0.0001, 'contextual ranking weights should normalize');

  const invalid = resolver.loadActiveStrategy({ dir: strategyDir, id: 'invalid_profile' });
  assert.strictEqual(invalid.validation.strict_ok, false);
  assert.ok(invalid.validation.errors.includes('admission_policy_type_conflict:collector_remediation'));
  assert.ok(invalid.validation.errors.includes('promotion_policy_min_shipped_gt_min_attempted'));
  assert.ok(invalid.validation.warnings.some(w => w.startsWith('risk_policy_invalid_risk_filtered:')));

  assert.throws(
    () => resolver.loadActiveStrategy({ dir: strategyDir, id: 'invalid_profile', strict: true }),
    /strategy_invalid:invalid_profile:/
  );

  writeJson(path.join(tmpRoot, 'outcome_fitness.json'), {
    version: '1.0',
    ts: '2026-02-21T00:00:00.000Z',
    strategy_policy: {
      strategy_id: 'default_general',
      promotion_policy_overrides: {
        disable_legacy_fallback_after_quality_receipts: 14,
        max_success_criteria_quality_insufficient_rate: 0.45
      },
      value_currency_policy_overrides: {
        default_currency: 'revenue',
        currency_overrides: {
          revenue: {
            ranking_weights: {
              expected_value: 0.28,
              time_to_value: 0.11
            }
          }
        },
        objective_overrides: {
          T1_test: {
            primary_currency: 'revenue'
          }
        }
      }
    }
  });
  process.env.OUTCOME_FITNESS_POLICY_PATH = path.join(tmpRoot, 'outcome_fitness.json');
  const overlayed = resolver.loadActiveStrategy({ dir: strategyDir, id: 'default_general' });
  assert.strictEqual(overlayed.promotion_policy.disable_legacy_fallback_after_quality_receipts, 14);
  assert.strictEqual(overlayed.promotion_policy.max_success_criteria_quality_insufficient_rate, 0.45);
  assert.strictEqual(overlayed.value_currency_policy.default_currency, 'revenue');
  assert.strictEqual(
    overlayed.value_currency_policy.objective_overrides.T1_test.primary_currency,
    'revenue'
  );
  assert.ok(
    Number(
      overlayed.value_currency_policy.currency_overrides.revenue.ranking_weights.expected_value || 0
    ) > 0.2,
    'outcome overlay should elevate revenue expected_value weighting'
  );

  console.log('strategy_resolver.test.js: OK');
  if (outcomePolicyBefore == null) delete process.env.OUTCOME_FITNESS_POLICY_PATH;
  else process.env.OUTCOME_FITNESS_POLICY_PATH = outcomePolicyBefore;
}

try {
  run();
} catch (err) {
  console.error(`strategy_resolver.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

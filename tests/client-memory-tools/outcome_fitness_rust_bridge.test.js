#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-fitness-rust-'));
  const clientRoot = path.join(workspace, 'client');
  const policyPath = path.join(clientRoot, 'local', 'state', 'adaptive', 'strategy', 'outcome_fitness.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    ts: '2026-03-17T00:00:00.000Z',
    realized_outcome_score: 120,
    strategy_policy: {
      strategy_id: ' growth_loop ',
      threshold_overrides: {
        min_signal_quality: '0.75',
        ignored_key: 99
      },
      ranking_weights_override: {
        composite: 2,
        actionability: 1,
        risk_penalty: 1
      },
      proposal_type_threshold_offsets: {
        'Code Change!!': {
          min_directive_fit: '0.4',
          ignored_key: 9
        }
      },
      promotion_policy_overrides: {
        disable_legacy_fallback_after_quality_receipts: '12',
        max_success_criteria_quality_insufficient_rate: '0.3339'
      },
      value_currency_policy_overrides: {
        default_currency: ' Revenue ',
        currency_overrides: {
          quality: {
            composite: 1,
            risk_penalty: 1
          }
        },
        objective_overrides: {
          OBJ_1: {
            primary_currency: 'learning',
            ranking_weights: {
              expected_value: 2,
              actionability: 1
            }
          }
        }
      }
    },
    focus_policy: {
      min_focus_score_delta: 99
    },
    proposal_filter_policy: {
      require_success_criteria: false,
      min_success_criteria_count: 9
    }
  }, null, 2));

  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const mod = resetModule(path.join(ROOT, 'client/lib/outcome_fitness.ts'));
  const policy = mod.loadOutcomeFitnessPolicy(clientRoot);
  assert.equal(policy.found, true);
  assert.equal(policy.path, policyPath);
  assert.equal(policy.realized_outcome_score, 100);
  assert.equal(policy.strategy_policy.strategy_id, 'growth_loop');
  assert.deepEqual(policy.strategy_policy.threshold_overrides, {
    min_signal_quality: 0.75
  });
  assert.deepEqual(policy.strategy_policy.ranking_weights_override, {
    composite: 0.5,
    actionability: 0.25,
    risk_penalty: 0.25
  });
  assert.equal(policy.focus_policy.min_focus_score_delta, 20);
  assert.equal(policy.proposal_filter_policy.require_success_criteria, false);
  assert.equal(policy.proposal_filter_policy.min_success_criteria_count, 5);
  assert.equal(policy.strategy_policy.value_currency_policy_overrides.default_currency, 'revenue');

  const offsets = mod.proposalTypeThresholdOffsetsFor(policy, 'Code Change!!');
  assert.deepEqual(offsets, { min_directive_fit: 0.4 });
  assert.equal(mod.normalizeProposalTypeKey(' Growth Plan / 2026 '), 'growth_plan_2026');
  assert.equal(mod.normalizeValueCurrencyToken(' learning '), 'learning');
  assert.equal(mod.normalizeValueCurrencyToken(' nope '), '');

  console.log(JSON.stringify({ ok: true, type: 'outcome_fitness_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}

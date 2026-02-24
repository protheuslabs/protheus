#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    process.env[key] = String(value);
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

function run() {
  const controller = withEnv({
    AUTONOMY_VALUE_CURRENCY_RANKING_ENABLED: '1',
    AUTONOMY_VALUE_CURRENCY_RANK_BLEND: '0.5',
    AUTONOMY_VALUE_CURRENCY_RANK_BONUS_CAP: '20'
  }, () => {
    const modulePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  });

  const revenueWeighted = controller.expectedValueSignalForProposal({
    expected_impact: 'medium',
    meta: {
      expected_value_score: 60,
      value_oracle_applies: true,
      value_oracle_pass: true,
      value_oracle_priority_score: 80,
      value_oracle_primary_currency: 'revenue',
      value_oracle_matched_first_sentence_currencies: ['revenue']
    }
  });
  assert.strictEqual(revenueWeighted.base_score, 60, 'direct expected value should remain base score');
  assert.strictEqual(revenueWeighted.source, 'expected_value_score', 'base source should report direct score');
  assert.strictEqual(revenueWeighted.currency, 'revenue', 'primary value currency should be revenue');
  assert.ok(revenueWeighted.score > revenueWeighted.base_score, 'revenue currency weighting should raise expected value score');
  assert.ok(Number(revenueWeighted.currency_delta) > 0, 'currency delta should be positive for revenue-weighted score');

  const learningWeighted = controller.expectedValueSignalForProposal({
    expected_impact: 'medium',
    meta: {
      value_oracle_applies: true,
      value_oracle_pass: true,
      value_oracle_priority_score: 80,
      value_oracle_primary_currency: 'learning'
    }
  });
  assert.strictEqual(learningWeighted.source, 'value_oracle_priority_score', 'oracle priority should become base when direct value is absent');
  assert.strictEqual(learningWeighted.base_score, 80, 'oracle priority should define base score');
  assert.ok(learningWeighted.score < learningWeighted.base_score, 'learning currency should slightly down-rank expected value');
  assert.ok(Number(learningWeighted.currency_delta) < 0, 'learning-weighted delta should be negative');

  const ranked = controller.strategyRankForCandidate({
    proposal: {
      id: 'PVCR-001',
      expected_impact: 'high',
      risk: 'low',
      meta: {
        expected_value_score: 55,
        value_oracle_applies: true,
        value_oracle_pass: true,
        value_oracle_priority_score: 75,
        value_oracle_primary_currency: 'user_value',
        value_oracle_matched_currencies: ['user_value']
      }
    },
    composite_score: 72,
    actionability: { score: 70 },
    directive_fit: { score: 61 },
    quality: { score: 66 }
  }, null);
  assert.ok(ranked && ranked.components, 'strategy ranking should include component breakdown');
  assert.strictEqual(ranked.components.value_currency, 'user_value', 'strategy ranking should expose selected value currency');
  assert.strictEqual(
    typeof ranked.components.value_currency_multiplier,
    'number',
    'strategy ranking should expose value currency multiplier for audit'
  );
  assert.strictEqual(
    typeof ranked.components.expected_value_source,
    'string',
    'strategy ranking should expose expected value source for audit'
  );

  console.log('autonomy_value_currency_ranking.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_value_currency_ranking.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

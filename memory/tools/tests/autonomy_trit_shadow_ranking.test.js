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
    AUTONOMY_TRIT_SHADOW_ENABLED: '1',
    AUTONOMY_TRIT_SHADOW_BONUS_BLEND: '0.2',
    AUTONOMY_TRIT_SHADOW_TOP_K: '3'
  }, () => {
    const modulePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  });

  const strongCandidate = {
    proposal: { id: 'TRIT-STRONG-001', risk: 'low' },
    quality: { score: 84 },
    directive_fit: { score: 78 },
    actionability: { score: 80 },
    value_signal: { score: 82 },
    composite_score: 83,
    composite_min_score: 62,
    risk: 'low',
    objective_binding: { pass: true },
    budget_pacing_gate: { pass: true },
    strategy_rank: { adjustments: { non_yield_penalty: { penalty: 2 } } },
    strategy_rank_bonus: { total: 3 }
  };
  const weakCandidate = {
    proposal: { id: 'TRIT-WEAK-001', risk: 'high' },
    quality: { score: 41 },
    directive_fit: { score: 36 },
    actionability: { score: 33 },
    value_signal: { score: 30 },
    composite_score: 35,
    composite_min_score: 62,
    risk: 'high',
    objective_binding: { pass: false },
    budget_pacing_gate: { pass: false },
    strategy_rank: { adjustments: { non_yield_penalty: { penalty: 24 } } },
    strategy_rank_bonus: { total: 0 }
  };

  const strongShadow = controller.strategyTritShadowForCandidate(strongCandidate);
  const weakShadow = controller.strategyTritShadowForCandidate(weakCandidate);
  assert.ok(strongShadow && strongShadow.belief, 'strong candidate should produce trit shadow belief');
  assert.ok(weakShadow && weakShadow.belief, 'weak candidate should produce trit shadow belief');
  assert.strictEqual(strongShadow.belief.label, 'ok', 'strong candidate should map to positive trit');
  assert.strictEqual(weakShadow.belief.label, 'pain', 'weak candidate should map to pain trit');
  assert.ok(
    Number(strongShadow.adjusted_score || strongShadow.score || 0)
      > Number(weakShadow.adjusted_score || weakShadow.score || 0),
    'strong candidate should outrank weak candidate in trit shadow score'
  );

  const eligible = [
    {
      ...weakCandidate,
      strategy_rank_adjusted: 99,
      strategy_trit_shadow: weakShadow
    },
    {
      ...strongCandidate,
      strategy_rank_adjusted: 50,
      strategy_trit_shadow: strongShadow
    }
  ];
  const summary = controller.strategyTritShadowRankingSummary(
    eligible,
    'TRIT-WEAK-001',
    'exploit'
  );
  assert.ok(summary && summary.enabled === true, 'ranking summary should be enabled');
  assert.strictEqual(summary.legacy_top_proposal_id, 'TRIT-WEAK-001', 'legacy top should follow input ordering');
  assert.strictEqual(summary.trit_top_proposal_id, 'TRIT-STRONG-001', 'trit top should pick stronger candidate');
  assert.strictEqual(summary.diverged_from_legacy_top, true, 'summary should record legacy-vs-trit divergence');
  assert.strictEqual(summary.diverged_from_selected, true, 'summary should record selected-vs-trit divergence');

  console.log('autonomy_trit_shadow_ranking.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_trit_shadow_ranking.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

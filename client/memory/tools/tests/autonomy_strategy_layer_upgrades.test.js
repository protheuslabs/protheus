#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

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

function loadController(vars = {}) {
  return withEnv(vars, () => {
    delete require.cache[require.resolve(CONTROLLER_PATH)];
    return require(CONTROLLER_PATH);
  });
}

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - (Math.max(0, Number(minutes || 0)) * 60 * 1000)).toISOString();
}

function run() {
  const baselineController = loadController({
    AUTONOMY_STRATEGY_RANK_NON_YIELD_PENALTY_ENABLED: '1',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_WINDOW_HOURS: '72',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_MIN_SAMPLES: '2',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_POLICY_HOLD_WEIGHT: '18',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_NO_PROGRESS_WEIGHT: '22',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_STOP_WEIGHT: '10',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_SHIPPED_RELIEF_WEIGHT: '8',
    AUTONOMY_STRATEGY_RANK_NON_YIELD_MAX_PENALTY: '30'
  });

  const candidate = {
    proposal: {
      id: 'SLU-001',
      type: 'unknown',
      expected_impact: 'medium',
      risk: 'low',
      meta: {
        expected_value_score: 65,
        objective_id: 'T2_growth_loop'
      }
    },
    objective_binding: {
      objective_id: 'T2_growth_loop'
    },
    capability_key: 'proposal:unknown',
    composite_score: 72,
    actionability: { score: 74 },
    directive_fit: { score: 66 },
    quality: { score: 68 }
  };

  const priorRuns = [
    {
      ts: isoMinutesAgo(50),
      type: 'autonomy_run',
      result: 'no_candidates_policy_daily_cap',
      proposal_type: 'unknown',
      objective_id: 'T2_growth_loop'
    },
    {
      ts: isoMinutesAgo(40),
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'no_change',
      proposal_type: 'unknown',
      objective_id: 'T2_growth_loop'
    },
    {
      ts: isoMinutesAgo(30),
      type: 'autonomy_run',
      result: 'stop_init_gate_quality_exhausted',
      proposal_type: 'unknown',
      objective_id: 'T2_growth_loop'
    },
    {
      ts: isoMinutesAgo(20),
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      proposal_type: 'unknown',
      objective_id: 'T2_growth_loop'
    }
  ];

  const penalty = baselineController.candidateNonYieldPenaltySignal(candidate, { priorRuns });
  assert.strictEqual(penalty.applied, true, 'non-yield penalty should apply with enough matching samples');
  assert.strictEqual(penalty.samples, 4, 'non-yield penalty should count matching window events');
  assert.ok(Number(penalty.penalty) > 0, 'non-yield penalty should be positive when holds/no-progress dominate');

  const rankedWithPenalty = baselineController.strategyRankForCandidate(candidate, null, { priorRuns });
  const rankedWithoutPenalty = baselineController.strategyRankForCandidate(candidate, null, { priorRuns: [] });
  assert.ok(
    Number(rankedWithPenalty.score) < Number(rankedWithoutPenalty.score),
    'strategy rank should decrease when non-yield penalty is present'
  );
  assert.ok(
    Number(rankedWithPenalty.components.non_yield_penalty || 0) > 0,
    'rank components should expose non-yield penalty value'
  );

  const tmpRoot = path.join(__dirname, 'temp_autonomy_strategy_layer_upgrades');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);
  const strategyDir = path.join(tmpRoot, 'strategies');
  const scorecardPath = path.join(tmpRoot, 'scorecards', 'latest.json');
  mkDir(strategyDir);

  writeJson(path.join(strategyDir, 'alpha.json'), {
    version: '1.0',
    id: 'alpha_primary',
    status: 'active',
    objective: { primary: 'alpha' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });
  writeJson(path.join(strategyDir, 'beta.json'), {
    version: '1.0',
    id: 'beta_canary',
    status: 'active',
    objective: { primary: 'beta' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });
  writeJson(path.join(strategyDir, 'gamma.json'), {
    version: '1.0',
    id: 'gamma_canary',
    status: 'active',
    objective: { primary: 'gamma' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });
  writeJson(scorecardPath, {
    ts: new Date().toISOString(),
    summaries: [
      { strategy_id: 'alpha_primary', metrics: { score: 80, confidence: 0.7 }, stage: 'validated' },
      { strategy_id: 'beta_canary', metrics: { score: 65, confidence: 0.6 }, stage: 'trial' },
      { strategy_id: 'gamma_canary', metrics: { score: 60, confidence: 0.55 }, stage: 'trial' }
    ]
  });

  const variantEnv = {
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_STRATEGY_SCORECARD_LATEST_PATH: scorecardPath,
    AUTONOMY_MULTI_STRATEGY_CANARY_ENABLED: '1',
    AUTONOMY_MULTI_STRATEGY_CANARY_FRACTION: '0.25',
    AUTONOMY_MULTI_STRATEGY_MAX_ACTIVE: '3',
    AUTONOMY_MULTI_STRATEGY_CANARY_ALLOW_EXECUTE: '1'
  };
  withEnv(variantEnv, () => {
    const controllerWithVariants = loadController(variantEnv);
    const priorForCanaryDue = [
      { ts: isoMinutesAgo(180), type: 'autonomy_run', result: 'executed' },
      { ts: isoMinutesAgo(120), type: 'autonomy_run', result: 'executed' },
      { ts: isoMinutesAgo(60), type: 'autonomy_run', result: 'executed' }
    ];
    const canarySelection = controllerWithVariants.selectStrategyForRun('2026-02-24', priorForCanaryDue);
    assert.strictEqual(canarySelection.canary_due, true, 'attempt index 4 should trigger canary selection');
    assert.strictEqual(canarySelection.mode, 'canary_variant', 'canary due should select canary variant mode');
    assert.ok(Array.isArray(canarySelection.ranked) && canarySelection.ranked.length >= 2, 'ranked strategies should include variants');
    assert.ok(
      String(canarySelection.strategy && canarySelection.strategy.id || '') !== String(canarySelection.ranked[0].strategy_id || ''),
      'canary selection should choose outside the top primary row'
    );

    const priorForPrimary = [
      { ts: isoMinutesAgo(120), type: 'autonomy_run', result: 'executed' },
      { ts: isoMinutesAgo(60), type: 'autonomy_run', result: 'executed' }
    ];
    const primarySelection = controllerWithVariants.selectStrategyForRun('2026-02-24', priorForPrimary);
    assert.strictEqual(primarySelection.canary_due, false, 'attempt index 3 should remain primary');
    assert.strictEqual(primarySelection.mode, 'primary_best', 'non-canary attempt should stay on primary best strategy');
    assert.strictEqual(
      String(primarySelection.strategy && primarySelection.strategy.id || ''),
      String(primarySelection.ranked[0] && primarySelection.ranked[0].strategy_id || ''),
      'primary selection should choose top-ranked strategy'
    );
  });

  console.log('autonomy_strategy_layer_upgrades.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_layer_upgrades.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function rustPayload(mode, input) {
  const out = runBacklogAutoscalePrimitive(mode, input, { allow_cli_fallback: true });
  assert.ok(out && out.ok === true, `bridge call failed for mode=${mode}`);
  assert.ok(out.payload && out.payload.ok === true, `invalid rust payload for mode=${mode}`);
  return out.payload.payload;
}

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const strategyProfile = rustPayload('strategy_profile', {
    strategy: { id: 'alpha_primary', status: 'active', execution_policy: { mode: 'score_only' } }
  });
  assert.deepStrictEqual(strategyProfile.strategy, {
    id: 'alpha_primary',
    status: 'active',
    execution_policy: { mode: 'score_only' }
  });

  const variants = rustPayload('active_strategy_variants', {
    listed: [
      { id: 'b', status: 'active' },
      { id: 'a', status: 'active', validation: { strict_ok: true } },
      { id: 'x', status: 'inactive' },
      { id: 'z', status: 'active', validation: { strict_ok: false } },
      { id: 'a', status: 'active', note: 'duplicate_should_drop' }
    ],
    primary: { id: 'p', status: 'active' }
  });
  assert.deepStrictEqual(
    variants.variants.map((row) => String(row.id)),
    ['a', 'b', 'p'],
    'active_strategy_variants should filter, dedupe, and sort by id'
  );

  const scorecards = rustPayload('strategy_scorecard_summaries', {
    path: '/tmp/scorecards/latest.json',
    ts: '2026-03-04T00:00:00.000Z',
    summaries: [
      { strategy_id: 'alpha', metrics: { score: 77.5, confidence: 0.91 }, stage: 'Validated' },
      { strategy_id: 'beta', metrics: { score: 63, confidence: 0.55 }, stage: '' }
    ]
  });
  assert.strictEqual(scorecards.path, '/tmp/scorecards/latest.json');
  assert.strictEqual(scorecards.ts, '2026-03-04T00:00:00.000Z');
  assert.deepStrictEqual(scorecards.by_id.alpha, {
    score: 77.5,
    confidence: 0.91,
    stage: 'validated'
  });
  assert.deepStrictEqual(scorecards.by_id.beta, {
    score: 63,
    confidence: 0.55,
    stage: null
  });

  const outcomePolicy = rustPayload('outcome_fitness_policy', {
    policy: { proposal_filter_policy: { require_success_criteria: true } }
  });
  assert.deepStrictEqual(outcomePolicy.policy, {
    proposal_filter_policy: { require_success_criteria: true }
  });
  const outcomePolicyFallback = rustPayload('outcome_fitness_policy', {
    policy: ['not', 'an', 'object']
  });
  assert.deepStrictEqual(outcomePolicyFallback.policy, {}, 'non-object policy should normalize to {}');

  const eyes = rustPayload('load_eyes_map', {
    cfg_eyes: [
      { id: 'github_releases', parser_type: 'rss', status: 'active' },
      { id: 'hn_frontpage', parser_type: 'rss', status: 'active' }
    ],
    state_eyes: [
      { id: 'github_releases', status: 'paused', score_ema: 0.77 },
      { id: 'reddit_agents', parser_type: 'json', status: 'active' }
    ]
  });
  assert.deepStrictEqual(
    eyes.eyes.map((row) => String(row.id)),
    ['github_releases', 'hn_frontpage', 'reddit_agents'],
    'load_eyes_map should preserve cfg order and append unseen state eyes'
  );
  assert.deepStrictEqual(eyes.eyes[0], {
    id: 'github_releases',
    parser_type: 'rss',
    status: 'paused',
    score_ema: 0.77
  });

  const fallbackIds = rustPayload('fallback_directive_objective_ids', {
    directive_ids: ['T1_alpha', ' T2_beta ', 'invalid', 'T2_beta', 'T3_gamma']
  });
  assert.deepStrictEqual(
    fallbackIds.ids,
    ['T1_alpha', 'T2_beta', 'T3_gamma'],
    'fallback_directive_objective_ids should sanitize, dedupe, and sort'
  );

  const queuePressure = rustPayload('queue_pressure_snapshot', {
    statuses: ['pending', 'pending', 'accepted', 'closed', 'pending'],
    warn_count: 2,
    critical_count: 4,
    warn_ratio: 0.3,
    critical_ratio: 0.9
  });
  assert.strictEqual(queuePressure.total, 5);
  assert.strictEqual(queuePressure.pending, 3);
  assert.strictEqual(queuePressure.pressure, 'warning');
  assert.strictEqual(queuePressure.pending_ratio, 0.6);

  const outcomeStats = rustPayload('collect_outcome_stats', {
    by_eye: {
      eye_alpha: { shipped: 3, no_change: 1, reverted: 0 },
      eye_beta: { shipped: 1, no_change: 2, reverted: 1 },
      eye_gamma: { shipped: 0, no_change: 1, reverted: 0 }
    },
    by_topic: {
      reliability: { shipped: 4, no_change: 1, reverted: 0 },
      speed: { shipped: 1, no_change: 2, reverted: 2 }
    },
    global: { shipped: 5, no_change: 4, reverted: 3 },
    eye_min_samples: 3,
    topic_min_samples: 4
  });
  assert.deepStrictEqual(outcomeStats.global, {
    shipped: 5,
    no_change: 4,
    reverted: 3,
    total: 12
  });
  assert.ok(outcomeStats.eye_biases.eye_alpha, 'eye_alpha bias should be retained');
  assert.ok(outcomeStats.eye_biases.eye_beta, 'eye_beta bias should be retained');
  assert.ok(!outcomeStats.eye_biases.eye_gamma, 'eye_gamma should be filtered by min samples');
  assert.ok(outcomeStats.topic_biases.reliability, 'topic reliability should have a bias row');

  const proposalForCriteria = {
    type: 'optimization',
    action_spec: {
      success_criteria: [
        'Latency <= 200ms within 1 day',
        { metric: 'throughput', target: '>= 15%', horizon: 'next run' },
        { name: 'uptime', goal: '99.9% weekly' }
      ],
      verify: ['Run smoke tests and compare pass rate']
    },
    validation: ['At least 3 checks pass']
  };
  const criteriaTs = loadController(false).parseSuccessCriteriaRows(proposalForCriteria);
  const criteriaRust = loadController(true).parseSuccessCriteriaRows(proposalForCriteria);
  assert.deepStrictEqual(
    criteriaRust,
    criteriaTs,
    'parseSuccessCriteriaRows should match TS fallback output'
  );

  const subPrimitive = rustPayload('subdirective_v2_signals', {
    required: true,
    has_concrete_target: true,
    has_expected_delta: false,
    has_verification_step: true,
    target_count: 2,
    verify_count: 1,
    success_criteria_count: 3
  });
  assert.deepStrictEqual(subPrimitive, {
    required: true,
    has_concrete_target: true,
    has_expected_delta: false,
    has_verification_step: true,
    target_count: 2,
    verify_count: 1,
    success_criteria_count: 3
  });

  console.log('autonomy_strategy_support_primitives_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_support_primitives_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

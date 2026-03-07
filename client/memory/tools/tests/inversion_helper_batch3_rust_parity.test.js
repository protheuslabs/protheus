#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function compareFloat(actual, expected, message) {
  assert(Math.abs(Number(actual) - Number(expected)) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const baseBand = { novice: 0.1, developing: 0.2, mature: 0.3, seasoned: 0.4, legendary: 0.5 };
  const rawBand = { novice: 0.9, mature: -0.2, legendary: 3 };
  assert.deepStrictEqual(
    rust.normalizeBandMap(rawBand, baseBand, 0, 1),
    ts.normalizeBandMap(rawBand, baseBand, 0, 1),
    'normalizeBandMap mismatch'
  );

  const baseImpact = { low: 0.1, medium: 0.2, high: 0.3, critical: 0.4 };
  const rawImpact = { high: 0.75, critical: 2 };
  assert.deepStrictEqual(
    rust.normalizeImpactMap(rawImpact, baseImpact, 0, 1),
    ts.normalizeImpactMap(rawImpact, baseImpact, 0, 1),
    'normalizeImpactMap mismatch'
  );

  const baseTarget = { tactical: 0.1, belief: 0.2, identity: 0.3, directive: 0.4, constitution: 0.5 };
  const rawTarget = { identity: 0.8, tactical: -2 };
  assert.deepStrictEqual(
    rust.normalizeTargetMap(rawTarget, baseTarget, 0, 1),
    ts.normalizeTargetMap(rawTarget, baseTarget, 0, 1),
    'normalizeTargetMap mismatch'
  );

  const basePolicy = {
    rank: 2,
    live_enabled: false,
    test_enabled: true,
    require_human_veto_live: true,
    min_shadow_hours: 4
  };
  const rawPolicy = {
    rank: 12,
    live_enabled: 'yes',
    test_enabled: 'off',
    require_human_veto_live: '0',
    min_shadow_hours: 999999
  };
  assert.deepStrictEqual(
    rust.normalizeTargetPolicy(rawPolicy, basePolicy),
    ts.normalizeTargetPolicy(rawPolicy, basePolicy),
    'normalizeTargetPolicy mismatch'
  );

  const windowMap = { tactical: 14, belief: 30, identity: 45 };
  assert.strictEqual(
    rust.windowDaysForTarget(windowMap, 'identity', 90),
    ts.windowDaysForTarget(windowMap, 'identity', 90),
    'windowDaysForTarget mismatch'
  );

  const retentionPolicy = {
    tier_transition: {
      window_days_by_target: { tactical: 60, identity: 120 },
      minimum_window_days_by_target: { belief: 45 }
    },
    shadow_pass_gate: {
      window_days_by_target: { tactical: 30, directive: 90 }
    }
  };
  assert.strictEqual(
    rust.tierRetentionDays(retentionPolicy),
    ts.tierRetentionDays(retentionPolicy),
    'tierRetentionDays mismatch'
  );

  const llmPayload = {
    candidates: [
      { id: 'c1', filters: ['risk_guard_compaction', 'fallback_pathing'], probability: 0.82, rationale: 'safe path' },
      { id: 'c2', filters: [], probability: 0.2, rationale: 'invalid' },
      { id: 'c3', filter_stack: ['goal_decomposition'], probability: 0.67, reason: 'works' }
    ]
  };
  assert.deepStrictEqual(
    rust.parseCandidateListFromLlmPayload(llmPayload),
    ts.parseCandidateListFromLlmPayload(llmPayload),
    'parseCandidateListFromLlmPayload mismatch'
  );

  const objective = 'reduce budget drift while preserving quality';
  assert.deepStrictEqual(
    rust.heuristicFilterCandidates(objective),
    ts.heuristicFilterCandidates(objective),
    'heuristicFilterCandidates mismatch'
  );

  const decision = {
    allowed: true,
    attractor: { score: 0.76 },
    input: { effective_certainty: 0.88 },
    gating: { required_certainty: 0.55 }
  };
  const candidate = { score_hint: 0.64 };
  const trialCfg = {
    score_weights: {
      decision_allowed: 0.35,
      attractor: 0.2,
      certainty_margin: 0.15,
      library_similarity: 0.1,
      runtime_probe: 0.2
    }
  };
  compareFloat(
    rust.scoreTrial(decision, candidate, trialCfg, true),
    ts.scoreTrial(decision, candidate, trialCfg, true),
    'scoreTrial mismatch'
  );

  const trialRows = [
    { id: 'n1', filters: ['constraint_reframe'], source: 'heuristic', probability: 0.7, score_hint: 0.55 },
    { filters: ['goal_decomposition', 'fallback_pathing'], source: 'llm', probability: 0.4, score_hint: 0.5 }
  ];
  assert.deepStrictEqual(
    rust.mutateTrialCandidates(trialRows),
    ts.mutateTrialCandidates(trialRows),
    'mutateTrialCandidates mismatch'
  );

  console.log('inversion_helper_batch3_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch3_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

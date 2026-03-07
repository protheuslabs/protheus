#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function candidate(id, proposalType, opts = {}) {
  return {
    id,
    name: id,
    trigger: { proposal_type: proposalType, min_occurrences: 2, intent_signature: 'sig' },
    tradeoffs: { speed_weight: 0.34, robustness_weight: 0.33, cost_weight: 0.33 },
    risk_policy: { max_risk_per_action: 45, allowed_risks: ['low', 'medium'] },
    intent: {
      uncertainty_band: opts.uncertainty || 'medium',
      signals: opts.signals || { feasibility: 0, risk: 0, novelty: 0 }
    },
    mutation: opts.mutation || null,
    steps: opts.steps || [
      { id: 'execute', type: 'command', command: 'node client/systems/autonomy/autonomy_controller.js run <date>', retries: 1, timeout_ms: 120000 },
      { id: 'verify', type: 'gate', command: 'node client/systems/autonomy/strategy_execute_guard.js run <date>', retries: 0, timeout_ms: 120000 },
      { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', retries: 0, timeout_ms: 30000 }
    ],
    metadata: {
      shipped_rate: Number(opts.shipped_rate || 0.3),
      failure_rate: Number(opts.failure_rate || 0.7),
      no_change_rate: Number(opts.no_change_rate || 0.5)
    }
  };
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const { evaluateCandidates } = require(path.join(root, 'systems', 'workflow', 'orchestron', 'nursery_tester.js'));

  const safeCandidate = candidate('wf_safe', 'external_intel', {
    uncertainty: 'low',
    signals: { feasibility: 1, risk: 0, novelty: 0 },
    mutation: { kind: 'guard_hardening' },
    steps: [
      { id: 'preflight', type: 'gate', command: 'node client/systems/spine/contract_check.js', retries: 0, timeout_ms: 60000 },
      { id: 'execute', type: 'command', command: 'node client/systems/autonomy/autonomy_controller.js run <date>', retries: 1, timeout_ms: 120000 },
      { id: 'rollback', type: 'command', command: 'node client/systems/autonomy/strategy_execute_guard.js rollback <date>', retries: 0, timeout_ms: 90000 },
      { id: 'verify', type: 'gate', command: 'node client/systems/autonomy/strategy_execute_guard.js run <date>', retries: 0, timeout_ms: 120000 },
      { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', retries: 0, timeout_ms: 30000 }
    ],
    shipped_rate: 0.55,
    failure_rate: 0.25,
    no_change_rate: 0.2
  });

  const riskyCandidate = candidate('wf_risky', 'publish_pipeline', {
    uncertainty: 'high',
    signals: { feasibility: -1, risk: -1, novelty: 1 },
    shipped_rate: 0.1,
    failure_rate: 0.85,
    no_change_rate: 0.7
  });

  const input = {
    candidates: [safeCandidate, riskyCandidate],
    pattern_rows: [
      { proposal_type: 'external_intel', attempts: 20, shipped: 11, no_change: 6, holds: 2, stops: 1 },
      { proposal_type: 'publish_pipeline', attempts: 20, shipped: 2, no_change: 13, holds: 3, stops: 2 }
    ],
    principle_snapshot: { score: 0.85 },
    red_team: { critical_fail_cases: 0 },
    adversarial_results: [
      { candidate_id: 'wf_safe', critical_failures: 0, non_critical_findings: 1 },
      { candidate_id: 'wf_risky', critical_failures: 1, non_critical_findings: 4 }
    ],
    value_context: {
      value_currency: 'execution',
      weights: {
        expected_value: 0.2,
        actionability: 0.25,
        signal_quality: 0.25,
        risk_penalty: 0.2
      }
    },
    policy: {
      min_safety_score: 0.45,
      max_regression_risk: 0.68,
      min_composite_score: 0.42,
      max_predicted_drift_delta: 0.02,
      min_predicted_yield_delta: -0.03,
      min_trit_alignment: -0.9,
      max_candidate_red_team_pressure: 0.72,
      max_candidate_adversarial_critical_failures: 0,
      max_candidate_adversarial_non_critical_findings: 8,
      max_promotions_per_run: 4
    }
  };

  const first = evaluateCandidates(input);
  const second = evaluateCandidates(JSON.parse(JSON.stringify(input)));

  assert.ok(first && first.ok === true, 'first run should succeed');
  assert.strictEqual(first.type, 'orchestron_nursery_scorecard', 'scorecard type should be stable');
  assert.strictEqual(first.contract_version, '1.0', 'contract version should be emitted');
  assert.ok(Array.isArray(first.scorecards) && first.scorecards.length === 2, 'expected two scorecards');
  assert.ok(Array.isArray(first.blocked) && first.blocked.length >= 1, 'expected blocked candidate list');
  assert.ok(Array.isArray(first.passing), 'expected passing list');
  assert.ok(first.summary && Number(first.summary.scorecards || 0) === 2, 'summary should include deterministic count');

  const scoreById = new Map(first.scorecards.map((row) => [String(row.candidate_id || ''), row]));
  const riskyCard = scoreById.get('wf_risky');
  const safeCard = scoreById.get('wf_safe');
  assert.ok(riskyCard, 'risky scorecard should exist');
  assert.ok(safeCard, 'safe scorecard should exist');

  for (const row of first.scorecards) {
    assert.ok(Number.isFinite(Number(row.predicted_yield_delta)), 'scorecard should include predicted_yield_delta');
    assert.ok(Number.isFinite(Number(row.predicted_drift_delta)), 'scorecard should include predicted_drift_delta');
    assert.ok(Number.isFinite(Number(row.safety_score)), 'scorecard should include safety_score');
    assert.ok(Number.isFinite(Number(row.regression_risk)), 'scorecard should include regression_risk');
  }

  const blockedIds = new Set(first.blocked.map((row) => String(row.candidate_id || '')));
  assert.ok(blockedIds.has('wf_risky'), 'risky candidate should be blocked');
  assert.ok(!blockedIds.has('wf_safe'), 'safe candidate should not be blocked');
  assert.ok(Array.isArray(riskyCard.reasons) && riskyCard.reasons.length >= 1, 'blocked scorecard should include failure reasons');

  const passIds = new Set(first.passing.map((row) => String(row && row.candidate && row.candidate.id || '')));
  assert.ok(passIds.has('wf_safe'), 'safe candidate should pass');
  assert.ok(!passIds.has('wf_risky'), 'risky candidate should not pass');

  const firstOrder = first.scorecards.map((row) => `${row.candidate_id}:${row.pass ? 1 : 0}`);
  const secondOrder = second.scorecards.map((row) => `${row.candidate_id}:${row.pass ? 1 : 0}`);
  assert.deepStrictEqual(firstOrder, secondOrder, 'scorecard ordering and pass/fail should be deterministic');

  console.log('orchestron_nursery_scorecard_contract.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_nursery_scorecard_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

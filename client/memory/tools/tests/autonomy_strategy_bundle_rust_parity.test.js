#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_HARD_MAX_DAILY_RUNS_CAP = '9';
  process.env.AUTONOMY_HARD_MAX_DAILY_TOKEN_CAP = '3000';
  process.env.AUTONOMY_HARD_MAX_TOKENS_PER_ACTION = '900';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function run() {
  const ts = loadController(false);
  const rust = loadController(true);

  assert.deepStrictEqual(
    rust.defaultCriteriaPatternMemory(),
    ts.defaultCriteriaPatternMemory(),
    'defaultCriteriaPatternMemory parity mismatch'
  );

  const strategy = {
    execution_policy: {
      mode: 'canary_execute',
      canary_daily_exec_limit: 5
    },
    exploration_policy: {
      fraction: 0.31,
      every_n: 4,
      min_eligible: 5
    },
    budget_policy: {
      daily_runs_cap: 17,
      daily_token_cap: 4200,
      max_tokens_per_action: 1100,
      token_cost_per_1k: 0.023,
      daily_usd_cap: 4.2,
      per_action_avg_usd_cap: 0.55,
      monthly_usd_allocation: 80,
      monthly_credits_floor_pct: 0.2,
      min_projected_tokens_for_burn_check: 280,
      per_capability_caps: { web_search: 2 }
    }
  };

  assert.deepStrictEqual(
    rust.effectiveStrategyExecutionMode(strategy),
    ts.effectiveStrategyExecutionMode(strategy),
    'effectiveStrategyExecutionMode parity mismatch'
  );

  assert.deepStrictEqual(
    rust.effectiveStrategyCanaryExecLimit(strategy),
    ts.effectiveStrategyCanaryExecLimit(strategy),
    'effectiveStrategyCanaryExecLimit parity mismatch'
  );

  assert.deepStrictEqual(
    rust.effectiveStrategyExploration(strategy),
    ts.effectiveStrategyExploration(strategy),
    'effectiveStrategyExploration parity mismatch'
  );

  assert.deepStrictEqual(
    rust.effectiveStrategyBudget(strategy),
    ts.effectiveStrategyBudget(strategy),
    'effectiveStrategyBudget parity mismatch'
  );

  const storedProposal = {
    id: 'p1',
    title: 'Route this through bird_x connectors',
    status: 'queued',
    meta: {
      source_eye: 'local_state_fallback',
      note: 'x'
    }
  };
  assert.deepStrictEqual(
    rust.normalizeStoredProposalRow(storedProposal, 'pending'),
    ts.normalizeStoredProposalRow(storedProposal, 'pending'),
    'normalizeStoredProposalRow parity mismatch'
  );

  const pool = [
    {
      proposal: {
        id: 'p-eyes-1',
        title: 'Eyes monitor bird_x routing',
        summary: 'Use eyes with bird_x to inspect engagement loops',
        meta: {
          source_eye: 'local_state_fallback'
        }
      }
    },
    {
      proposal: {
        id: 'p-eyes-2',
        title: 'Normal proposal',
        summary: 'No drift here',
        meta: {}
      }
    }
  ];
  assert.deepStrictEqual(
    rust.detectEyesTerminologyDriftInPool(pool),
    ts.detectEyesTerminologyDriftInPool(pool),
    'detectEyesTerminologyDriftInPool parity mismatch'
  );

  const fixedNow = Date.parse('2026-03-04T12:00:00.000Z');
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const priorRuns = [
      {
        type: 'autonomy_run',
        proposal_id: 'p1',
        result: 'score_only_preview',
        ts: '2026-03-04T11:10:00.000Z',
        preview_verification: {
          passed: false,
          outcome: 'no_change'
        }
      },
      {
        type: 'autonomy_run',
        proposal_id: 'p1',
        result: 'score_only_evidence',
        ts: '2026-03-04T11:40:00.000Z',
        preview_verification: {
          passed: true,
          outcome: 'ok'
        }
      },
      {
        type: 'autonomy_run',
        proposal_id: 'p2',
        result: 'score_only_preview',
        ts: '2026-03-04T11:50:00.000Z'
      }
    ];
    assert.deepStrictEqual(
      rust.scoreOnlyProposalChurn(priorRuns, 'p1', 2),
      ts.scoreOnlyProposalChurn(priorRuns, 'p1', 2),
      'scoreOnlyProposalChurn parity mismatch'
    );
  } finally {
    Date.now = originalDateNow;
  }

  const blockers = [
    { code: 'manual_review', retryable: false }
  ];
  const signals = {
    qos: { status: 'warn' },
    safety: { status: 'fail' }
  };
  assert.deepStrictEqual(
    rust.preexecVerdictFromSignals(blockers, signals, '2026-03-04T13:00:00.000Z'),
    ts.preexecVerdictFromSignals(blockers, signals, '2026-03-04T13:00:00.000Z'),
    'preexecVerdictFromSignals parity mismatch'
  );

  const verification = {
    success_criteria: {
      checks: [
        { evaluated: false, reason: 'unsupported_metric' },
        { evaluated: true, reason: 'ok' }
      ],
      total_count: 2,
      unknown_count: 1,
      synthesized: false
    },
    primary_failure: null
  };
  assert.deepStrictEqual(
    rust.withSuccessCriteriaQualityAudit(verification),
    ts.withSuccessCriteriaQualityAudit(verification),
    'withSuccessCriteriaQualityAudit parity mismatch'
  );

  console.log('autonomy_strategy_bundle_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_bundle_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

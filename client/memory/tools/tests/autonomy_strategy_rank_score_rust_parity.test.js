#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function candidateFor(idx) {
  return {
    composite_score: 72 + idx,
    actionability: { score: 65 + idx },
    directive_fit: { score: 58 + idx },
    quality: { score: 80 - idx },
    proposal: {
      id: `cand-${idx}`,
      type: 'ops_remediation',
      risk: idx % 2 === 0 ? 'medium' : 'low',
      expected_impact: idx % 2 === 0 ? 'high' : 'medium',
      meta: {
        source_eye: 'test_eye',
        remediation_kind: idx % 2 === 0 ? 'transport' : 'policy'
      },
      action_spec: {
        command: 'node client/systems/ops/protheusctl.js status',
        verify: ['status check'],
        rollback_command: 'echo rollback'
      }
    }
  };
}

function buildPriorRuns() {
  const now = Date.now();
  return [
    {
      type: 'autonomy_run',
      ts: new Date(now - 30 * 60 * 1000).toISOString(),
      result: 'executed',
      outcome: 'shipped',
      proposal_type: 'ops_remediation',
      capability_key: 'system_exec'
    },
    {
      type: 'autonomy_run',
      ts: new Date(now - 60 * 60 * 1000).toISOString(),
      result: 'stop_policy_hold',
      proposal_type: 'ops_remediation',
      capability_key: 'system_exec'
    },
    {
      type: 'autonomy_run',
      ts: new Date(now - 90 * 60 * 1000).toISOString(),
      result: 'executed',
      outcome: 'no_change',
      proposal_type: 'ops_remediation',
      capability_key: 'system_exec'
    }
  ];
}

function run() {
  const priorRuns = buildPriorRuns();
  const opts = { priorRuns };
  for (let i = 0; i < 4; i += 1) {
    const cand = candidateFor(i);
    const tsOut = loadController(false).strategyRankForCandidate(cand, null, opts);
    const rustOut = loadController(true).strategyRankForCandidate(cand, null, opts);

    assert.strictEqual(
      rustOut.score,
      tsOut.score,
      `strategyRankForCandidate score parity mismatch for ${JSON.stringify(cand.proposal)}`
    );

    assert.deepStrictEqual(
      rustOut.weights,
      tsOut.weights,
      `strategyRankForCandidate weights parity mismatch for ${JSON.stringify(cand.proposal)}`
    );
  }

  console.log('autonomy_strategy_rank_score_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_rank_score_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

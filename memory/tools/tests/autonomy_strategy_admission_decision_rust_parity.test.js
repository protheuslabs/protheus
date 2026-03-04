#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    allow: row.allow === true,
    reason: row.reason == null ? null : String(row.reason),
    admission_preview: row.admission_preview || null,
    mutation_guard: row.mutation_guard || null,
    risk_score: row.risk_score == null ? null : Number(row.risk_score),
    max_risk_per_action: row.max_risk_per_action == null ? null : Number(row.max_risk_per_action),
    strategy_max_risk_per_action: row.strategy_max_risk_per_action == null ? null : Number(row.strategy_max_risk_per_action),
    hard_max_risk_per_action: row.hard_max_risk_per_action == null ? null : Number(row.hard_max_risk_per_action),
    duplicate_window_hours: row.duplicate_window_hours == null ? null : Number(row.duplicate_window_hours),
    recent_count: row.recent_count == null ? null : Number(row.recent_count)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const strategy = {
    id: 'main',
    execution_mode: 'score_only',
    admission_policy: {
      allowed_proposal_types: ['adaptive_mutation', 'patch', 'directive_clarification'],
      max_risk_per_action: 0.95,
      max_remediation_depth: 3
    }
  };

  const scenarios = [
    {
      proposal: {
        id: 'p-1',
        type: 'adaptive_mutation',
        title: 'Adaptive mutation test',
        meta: {
          adaptive_mutation_guard_applies: true,
          adaptive_mutation_guard_pass: false,
          adaptive_mutation_guard_reason: 'guard_failed'
        }
      },
      opts: {}
    },
    {
      proposal: {
        id: 'p-2',
        type: 'patch',
        risk: 'low',
        title: 'Patch candidate'
      },
      opts: {
        dedup_key: 'patch:p-2',
        recent_key_counts: new Map([['patch:p-2', 2]])
      }
    },
    {
      proposal: {
        id: 'p-3',
        type: 'patch',
        risk: 'low',
        title: 'Safe patch'
      },
      opts: {
        dedup_key: 'patch:p-3',
        recent_key_counts: new Map([['patch:p-3', 0]])
      }
    }
  ];

  for (const scenario of scenarios) {
    const tsOut = normalize(ts.strategyAdmissionDecision(scenario.proposal, strategy, scenario.opts));
    const rustOut = normalize(rust.strategyAdmissionDecision(scenario.proposal, strategy, scenario.opts));
    assert.deepStrictEqual(
      rustOut,
      tsOut,
      `strategyAdmissionDecision mismatch for ${JSON.stringify({ proposal: scenario.proposal.id, opts: Object.keys(scenario.opts || {}) })}`
    );
  }

  console.log('autonomy_strategy_admission_decision_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_strategy_admission_decision_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

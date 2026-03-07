#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function walkCandidates(rows, visitor) {
  const queue = Array.isArray(rows) ? rows.slice() : [];
  while (queue.length) {
    const row = queue.shift();
    if (!row || typeof row !== 'object') continue;
    visitor(row);
    const children = Array.isArray(row.children) ? row.children : [];
    for (const child of children) queue.push(child);
  }
}

function approxOne(weights) {
  const total = Number(weights.speed_weight || 0)
    + Number(weights.robustness_weight || 0)
    + Number(weights.cost_weight || 0);
  return Math.abs(total - 1) < 0.02;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const { generateCandidates } = require(path.join(root, 'systems', 'workflow', 'orchestron', 'candidate_generator.js'));

  const ctx = {
    date: '2026-02-26',
    strategy_id: 'rm011_contract_strategy',
    objective_primary: 'Generate bounded candidate plans with explicit tradeoffs.',
    intent: {
      id: 'intent_rm011',
      signature: 'intent_rm011_sig',
      objective: 'Generate bounded candidate plans with explicit tradeoffs.',
      constraints: {
        speed_weight: 0.4,
        robustness_weight: 0.35,
        cost_weight: 0.25
      },
      signals: {
        feasibility: 0,
        risk: -1,
        novelty: 1
      }
    },
    value_context: {
      value_currency: 'execution',
      weights: {
        expected_value: 0.25,
        actionability: 0.3,
        signal_quality: 0.25,
        risk_penalty: 0.2
      }
    },
    risk_policy: {
      max_risk_per_action: 45,
      allowed_risks: ['low', 'medium']
    },
    pattern_rows: [
      { proposal_type: 'external_intel', attempts: 12, shipped: 5, no_change: 5, holds: 1, stops: 1, recent_objective_id: 'obj_ext' },
      { proposal_type: 'publish_pipeline', attempts: 9, shipped: 3, no_change: 4, holds: 1, stops: 1, recent_objective_id: 'obj_pub' },
      { proposal_type: 'ops_hardening', attempts: 7, shipped: 2, no_change: 3, holds: 1, stops: 1, recent_objective_id: 'obj_ops' }
    ],
    registry_workflows: [
      {
        id: 'wf_active_external',
        name: 'External lane',
        status: 'active',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node client/habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node client/systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: { attempts: 12, shipped_rate: 0.4, failure_rate: 0.6 }
      }
    ],
    min_candidates: 1,
    max_candidates: 20,
    creative_llm: {
      enabled: false
    },
    fractal: {
      enabled: true,
      max_depth: 3,
      auto_depth_expansion: true,
      auto_depth_cap: 4,
      recurse_child_budget: 1,
      max_children_per_workflow: 2,
      min_attempts_for_split: 3,
      min_failure_rate_for_split: 0.4
    },
    runtime_evolution: {
      enabled: true,
      max_candidates: 3,
      failure_pressure_min: 0.35,
      no_change_pressure_min: 0.3
    }
  };

  const candidates = generateCandidates(ctx);
  assert.ok(Array.isArray(candidates), 'candidates should be an array');
  assert.ok(candidates.length >= 3, 'candidate generator should enforce lower bound of 3');
  assert.ok(candidates.length <= 8, 'candidate generator should enforce upper bound of 8');

  walkCandidates(candidates, (row) => {
    assert.ok(row.tradeoffs && typeof row.tradeoffs === 'object', 'candidate should include tradeoffs');
    assert.ok(approxOne(row.tradeoffs), 'tradeoff weights should normalize to ~1');
    assert.ok(row.risk_policy && typeof row.risk_policy === 'object', 'candidate should include risk policy');
    assert.ok(Number(row.risk_policy.max_risk_per_action || 0) >= 1, 'risk policy should include max risk per action');
    assert.ok(Array.isArray(row.risk_policy.allowed_risks) && row.risk_policy.allowed_risks.length >= 1, 'risk policy should include allowed risks');

    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : null;
    assert.ok(meta, 'candidate should include metadata');
    assert.ok(meta.explicit_tradeoffs && typeof meta.explicit_tradeoffs === 'object', 'candidate metadata should include explicit tradeoffs');
    assert.ok(meta.cost_profile && typeof meta.cost_profile === 'object', 'candidate metadata should include cost profile');
    assert.ok(Number(meta.cost_profile.estimated_tokens || 0) > 0, 'cost profile should include estimated token cost');
    assert.ok(['low', 'medium', 'high'].includes(String(meta.cost_profile.tier || '')), 'cost profile should include bounded tier');
    assert.ok(meta.risk_profile && typeof meta.risk_profile === 'object', 'candidate metadata should include risk profile');
    assert.ok(['low', 'medium', 'high'].includes(String(meta.risk_profile.level || '')), 'risk profile should include normalized level');
  });

  console.log('orchestron_candidate_generator_contract.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_candidate_generator_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

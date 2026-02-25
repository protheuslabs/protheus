#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function maxFractalDepth(node) {
  if (!node || typeof node !== 'object') return 0;
  const children = Array.isArray(node.children) ? node.children : [];
  if (!children.length) return Number(node.fractal_depth || 0);
  let maxDepth = Number(node.fractal_depth || 0);
  for (const child of children) {
    maxDepth = Math.max(maxDepth, maxFractalDepth(child));
  }
  return maxDepth;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const {
    generateCandidates,
    chooseMutationKinds
  } = require(path.join(root, 'systems', 'workflow', 'orchestron', 'candidate_generator.js'));

  const baseCtx = {
    date: '2026-02-25',
    strategy_id: 'emergence_strategy',
    objective_primary: 'Increase adaptive workflow quality with bounded risk.',
    intent: {
      id: 'intent_emergence',
      signature: 'intent_emergence_signature',
      constraints: {
        speed_weight: 0.34,
        robustness_weight: 0.36,
        cost_weight: 0.3
      },
      signals: {
        feasibility: 0,
        risk: 0,
        novelty: 1
      }
    },
    value_context: {
      value_currency: 'progress',
      weights: {
        expected_value: 0.2,
        actionability: 0.3,
        signal_quality: 0.25,
        risk_penalty: 0.15
      }
    },
    risk_policy: {
      max_risk_per_action: 40,
      allowed_risks: ['low', 'medium']
    },
    pattern_rows: [
      { proposal_type: 'external_intel', attempts: 12, shipped: 5, no_change: 5, holds: 1, stops: 1, recent_objective_id: 'obj_ext' },
      { proposal_type: 'publish_pipeline', attempts: 8, shipped: 2, no_change: 5, holds: 1, stops: 0, recent_objective_id: 'obj_pub' }
    ],
    registry_workflows: [
      {
        id: 'wf_external',
        name: 'External workflow',
        status: 'active',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: { attempts: 12, shipped_rate: 0.4, failure_rate: 0.6 }
      }
    ],
    min_candidates: 4,
    max_candidates: 7,
    creative_llm: {
      enabled: true,
      primary_source: true,
      reserved_slots: 2,
      max_candidates: 2,
      min_novelty_trit: -1,
      seed_candidates: [
        {
          name: 'Creative intake lane',
          proposal_type: 'external_intel.creative_a',
          objective: 'Novel intake resilience',
          mutation_kind: 'fractal_split',
          min_occurrences: 2
        },
        {
          name: 'Creative publish lane',
          proposal_type: 'publish_pipeline.creative_b',
          objective: 'Novel publish fallback',
          mutation_kind: 'retry_tuning',
          min_occurrences: 2
        }
      ]
    },
    fractal: {
      enabled: true,
      max_depth: 3,
      auto_depth_expansion: true,
      auto_depth_cap: 5,
      recurse_child_budget: 1,
      max_children_per_workflow: 3,
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

  const candidates = generateCandidates(baseCtx);
  assert.ok(Array.isArray(candidates) && candidates.length >= 4, 'expected generated candidates');
  const creativeCandidates = candidates.filter((row) => String(row && row.metadata && row.metadata.generation_kind || '') === 'creative_llm');
  assert.ok(creativeCandidates.length >= 2, 'creative primary mode should reserve at least two creative candidates');

  const mutationWorkflow = {
    id: 'wf_mutation_probe',
    steps: [{ id: 'execute', type: 'command', command: 'node test.js' }],
    metrics: { failure_rate: 0.62, no_change_rate: 0.58 }
  };
  const exploratoryKinds = chooseMutationKinds(
    mutationWorkflow,
    { intent: { signals: { feasibility: 0, risk: 0, novelty: 1 } } },
    { failure_pressure: 0.62, no_change_pressure: 0.58 }
  );
  assert.ok(exploratoryKinds.includes('fractal_split'), 'high uncertainty mutation selection should include fractal_split');
  assert.ok(exploratoryKinds.length >= 3, 'high uncertainty mutation selection should widen exploration set');

  const exploitKinds = chooseMutationKinds(
    mutationWorkflow,
    { intent: { signals: { feasibility: -1, risk: -1, novelty: -1 } } },
    { failure_pressure: 0.4, no_change_pressure: 0.2 }
  );
  assert.ok(
    exploitKinds[0] === 'guard_hardening' || exploitKinds[0] === 'rollback_path',
    'low uncertainty mutation selection should prioritize guard-focused mutations first'
  );

  const recursiveCtx = {
    ...baseCtx,
    max_candidates: 4,
    min_candidates: 2,
    creative_llm: { enabled: false },
    runtime_evolution: { enabled: false, max_candidates: 0 },
    pattern_rows: [
      { proposal_type: 'recursive_lane', attempts: 18, shipped: 2, no_change: 13, holds: 2, stops: 1, recent_objective_id: 'obj_recursive' }
    ],
    registry_workflows: [],
    fractal: {
      enabled: true,
      max_depth: 2,
      auto_depth_expansion: true,
      auto_depth_cap: 4,
      recurse_child_budget: 2,
      max_children_per_workflow: 2,
      min_attempts_for_split: 3,
      min_failure_rate_for_split: 0.4,
      recurse_when_failure_min: 0.55,
      recurse_when_no_change_min: 0.45,
      recurse_when_uncertainty_min: 0.45
    }
  };

  const recursiveCandidates = generateCandidates(recursiveCtx);
  const rootRecursive = recursiveCandidates.find((row) => Array.isArray(row && row.children) && row.children.length > 0);
  assert.ok(rootRecursive, 'expected recursive candidate with children');
  const childWithNested = (rootRecursive.children || []).find((child) => Array.isArray(child && child.children) && child.children.length > 0);
  assert.ok(childWithNested, 'expected automatic deeper recursion with nested children');
  assert.ok(maxFractalDepth(rootRecursive) >= 2, 'expected nested depth >= 2 for recursive fractal generation');

  console.log('orchestron_candidate_generator_emergence.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_candidate_generator_emergence.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

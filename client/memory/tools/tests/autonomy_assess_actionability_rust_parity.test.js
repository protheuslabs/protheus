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

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  const sub = row.subdirective_v2 && typeof row.subdirective_v2 === 'object' ? row.subdirective_v2 : {};
  const success = row.success_criteria && typeof row.success_criteria === 'object' ? row.success_criteria : {};
  return {
    pass: row.pass === true,
    score: Number(row.score || 0),
    reasons: Array.isArray(row.reasons)
      ? row.reasons.map((x) => String(x || ''))
      : [],
    executable: row.executable === true,
    rollback_signal: row.rollback_signal === true,
    generic_next_command_template: row.generic_next_command_template === true,
    subdirective_v2: {
      required: sub.required === true,
      has_concrete_target: sub.has_concrete_target === true,
      has_expected_delta: sub.has_expected_delta === true,
      has_verification_step: sub.has_verification_step === true,
      target_count: Number(sub.target_count || 0),
      verify_count: Number(sub.verify_count || 0),
      success_criteria_count: Number(sub.success_criteria_count || 0)
    },
    success_criteria: {
      required: success.required === true,
      exempt_type: success.exempt_type === true,
      min_count: Number(success.min_count || 0),
      measurable_count: Number(success.measurable_count || 0),
      total_count: Number(success.total_count || 0),
      pattern_penalty: Number(success.pattern_penalty || 0),
      pattern_hits: Array.isArray(success.pattern_hits) ? success.pattern_hits : []
    }
  };
}

function run() {
  const ts = loadController(false);
  const rust = loadController(true);

  const proposal = {
    id: 'p-action-1',
    type: 'ops_improvement',
    title: 'Implement targeted follow-up automation for revenue pipeline',
    summary: 'Execute concrete follow-up workflow and verify conversion lift.',
    expected_impact: 'high',
    risk: 'medium',
    suggested_next_command: 'node client/systems/autonomy/autonomy_controller.js run --task=\"apply follow-up\"',
    validation: [
      'conversion rate >= 10%',
      'weekly report generated'
    ],
    rollback_plan: 'rollback to previous workflow config if failure',
    meta: {
      relevance_score: 72,
      directive_fit_score: 69
    },
    action_spec: {
      rollback_command: 'git checkout -- workflow.yml',
      success_criteria: [
        { metric: 'conversion_rate', target: '>=10% within 7 days' }
      ],
      verify: ['conversion_rate >= 10%']
    },
    evidence: [
      { match: 'opportunity in revenue follow-up flow' }
    ]
  };

  const directiveFit = { score: 69 };
  const thresholds = { min_actionability_score: 45 };

  const expected = normalize(ts.assessActionability(proposal, directiveFit, thresholds));
  const got = normalize(rust.assessActionability(proposal, directiveFit, thresholds));
  assert.deepStrictEqual(got, expected, 'assessActionability mismatch');

  console.log('autonomy_assess_actionability_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_assess_actionability_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

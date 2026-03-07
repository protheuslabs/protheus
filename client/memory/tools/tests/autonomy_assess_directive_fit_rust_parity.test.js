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
  return {
    pass: row.pass === true,
    score: Number(row.score || 0),
    profile_available: row.profile_available === true,
    active_directive_ids: Array.isArray(row.active_directive_ids)
      ? row.active_directive_ids.map((x) => String(x || ''))
      : [],
    matched_positive: Array.isArray(row.matched_positive)
      ? row.matched_positive.map((x) => String(x || ''))
      : [],
    matched_negative: Array.isArray(row.matched_negative)
      ? row.matched_negative.map((x) => String(x || ''))
      : [],
    reasons: Array.isArray(row.reasons)
      ? row.reasons.map((x) => String(x || ''))
      : []
  };
}

function run() {
  const ts = loadController(false);
  const rust = loadController(true);

  const proposal = {
    id: 'p-fit-1',
    title: 'Increase revenue growth with measurable sales follow-up',
    type: 'ops_improvement',
    summary: 'Raise conversion by adding a guided flow and weekly review.',
    expected_impact: 'high',
    risk: 'low',
    validation: [
      'conversion rate up by >=10%',
      'weekly KPI snapshot posted'
    ],
    evidence: [
      { match: 'revenue growth from follow-up', evidence_ref: 'directive:T1_growth' }
    ]
  };

  const directiveProfile = {
    available: true,
    active_directive_ids: ['T1_growth'],
    positive_phrases: ['increase revenue growth', 'weekly kpi snapshot'],
    negative_phrases: ['deprioritize revenue'],
    positive_tokens: ['revenue', 'growth', 'conversion', 'sales'],
    negative_tokens: ['deprioritize'],
    strategy_tokens: ['scale', 'growth']
  };

  const thresholds = { min_directive_fit: 48 };
  const expected = normalize(ts.assessDirectiveFit(proposal, directiveProfile, thresholds));
  const got = normalize(rust.assessDirectiveFit(proposal, directiveProfile, thresholds));
  assert.deepStrictEqual(got, expected, 'assessDirectiveFit mismatch');

  console.log('autonomy_assess_directive_fit_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_assess_directive_fit_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

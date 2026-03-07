#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  asList,
  parseRiskLimits,
  normalizeDirectiveId,
  buildTier1DirectiveYaml,
  promptPlanForMissing
} = require('../../../systems/security/directive_intake.js');
const { validateTier1DirectiveQuality } = require('../../../lib/directive_resolver.js');

function run() {
  assert.deepStrictEqual(asList('a,b, c ,,d'), ['a', 'b', 'c', 'd']);
  assert.strictEqual(normalizeDirectiveId('my_plan_v1'), 'T1_my_plan_v1');
  assert.strictEqual(normalizeDirectiveId('T1_existing_v1'), 'T1_existing_v1');

  const risk = parseRiskLimits('max_drawdown_pct=10,max_monthly_burn=50000,label=guarded');
  assert.strictEqual(risk.max_drawdown_pct, 10);
  assert.strictEqual(risk.max_monthly_burn, 50000);
  assert.strictEqual(risk.label, 'guarded');

  const yaml = buildTier1DirectiveYaml({
    id: 'T1_test_quality_v1',
    primary: 'Build scalable compounding systems',
    timebound: 'by 2026-12-31',
    scope_in: ['automation', 'equity ventures'],
    scope_out: ['regulatory gray areas'],
    leading: ['weekly shipped experiments', 'MRR growth rate'],
    lagging: ['cashflow positive months'],
    approval_gates: ['risk-adjusted return review', 'security impact review'],
    risk_limits: {
      max_drawdown_pct: 10,
      max_single_bet_pct: 2,
      max_monthly_burn: 50000
    }
  });
  const quality = validateTier1DirectiveQuality(yaml, 'T1_test_quality_v1');
  assert.strictEqual(quality.ok, true, `expected generated YAML to pass; missing=${(quality.missing || []).join(',')}`);

  const plan = promptPlanForMissing([
    'intent.primary',
    'scope.included',
    'success_metrics.lagging',
    'approval_policy.additional_gates'
  ]);
  assert.ok(Array.isArray(plan) && plan.length >= 4);

  console.log('directive_intake.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`directive_intake.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

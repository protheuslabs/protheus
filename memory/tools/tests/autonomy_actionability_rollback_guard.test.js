#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const ctrl = require(path.join(repoRoot, 'systems', 'autonomy', 'autonomy_controller.js'));

  const base = {
    id: 'P-medium-rollback-guard',
    type: 'collector_remediation',
    title: 'Fix collector retry policy and test recovery',
    expected_impact: 'medium',
    risk: 'medium',
    suggested_next_command: 'node systems/routing/route_execute.js --task="repair collector retries for downtime recovery"',
    summary: 'Apply bounded retry and verify restored collection rate.',
    validation: [
      'error rate <= 5% within 24 hours',
      'throughput >= baseline within 1 day'
    ],
    evidence: [{ match: 'collector failed with timeout spike' }],
    meta: { relevance_score: 72, directive_fit_score: 66 }
  };

  const noRollback = ctrl.assessActionability(base, { score: 66 }, { min_actionability_score: 0 });
  assert.strictEqual(noRollback.pass, false, 'medium-risk executable proposal without rollback path must fail');
  assert.ok(
    Array.isArray(noRollback.reasons) && noRollback.reasons.includes('medium_risk_missing_rollback_path'),
    'missing rollback path reason should be present for medium-risk executable proposals'
  );

  const withRollback = ctrl.assessActionability({
    ...base,
    rollback_plan: 'Rollback by reverting the retry patch if error rate regresses.'
  }, { score: 66 }, { min_actionability_score: 0 });
  assert.strictEqual(withRollback.rollback_signal, true, 'rollback signal should be detected');
  assert.ok(
    !withRollback.reasons.includes('medium_risk_missing_rollback_path'),
    'rollback-guard reason should clear when rollback path is present'
  );
  assert.strictEqual(withRollback.pass, true, 'medium-risk executable proposal with rollback path should pass at zero threshold');

  console.log('autonomy_actionability_rollback_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_actionability_rollback_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


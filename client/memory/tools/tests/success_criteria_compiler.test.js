#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  compileSuccessCriteriaRows,
  compileProposalSuccessCriteria,
  toActionSpecRows
} = require('../../../lib/success_criteria_compiler.js');

function run() {
  const rows = compileSuccessCriteriaRows([
    { metric: 'experiment_artifact', target: '1 executable change/plan artifact produced', horizon: '24h' },
    { metric: 'reply_or_interview_count', target: '>=1 reply/interview signal against the draft', horizon: '7d' },
    'tokens <= 800'
  ], { source: 'action_spec.success_criteria' });

  assert.ok(rows.length >= 3, 'compiler should emit normalized rows');
  assert.ok(rows.some((r) => r.metric === 'artifact_count'), 'experiment_artifact should normalize to artifact_count');
  assert.ok(rows.some((r) => r.metric === 'reply_or_interview_count'), 'reply/interview metric should be preserved');
  assert.ok(rows.some((r) => r.metric === 'token_usage'), 'token usage rule should be classified');

  const actionRows = toActionSpecRows(rows);
  assert.ok(actionRows.every((r) => typeof r.metric === 'string' && typeof r.target === 'string'), 'action rows should be serializable');

  const proposalRows = compileProposalSuccessCriteria({
    action_spec: {
      success_criteria: [{ metric: 'collector_success_runs', target: '>=1 eye_run_ok in next 2 runs', horizon: '2 runs' }]
    }
  }, {
    include_verify: false,
    include_validation: false,
    allow_fallback: false
  });
  assert.strictEqual(proposalRows.length, 1, 'proposal compile should preserve explicit rows');
  assert.strictEqual(proposalRows[0].metric, 'artifact_count', 'collector_success_runs should normalize to machine-verifiable metric');

  const remappedRows = compileProposalSuccessCriteria({
    action_spec: {
      success_criteria: [{ metric: 'reply_or_interview_count', target: '>=1 reply/interview signal', horizon: '7d' }]
    }
  }, {
    include_verify: false,
    include_validation: false,
    allow_fallback: false,
    capability_key: 'proposal:collector_remediation'
  });
  assert.strictEqual(remappedRows.length, 1, 'remapped compile should emit one row');
  assert.strictEqual(remappedRows[0].metric, 'artifact_count', 'non-outreach proposal capability should remap reply metric to artifact_count');

  const noFallbackRows = compileProposalSuccessCriteria(
    { action_spec: {}, validation: ['do something'] },
    { include_verify: false, include_validation: false, allow_fallback: false }
  );
  assert.strictEqual(noFallbackRows.length, 0, 'allow_fallback=false should return empty set when no criteria exist');

  console.log('success_criteria_compiler.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`success_criteria_compiler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

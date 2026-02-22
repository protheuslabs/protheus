#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { evaluateSuccessCriteria, parseSuccessCriteriaRows } = require('../../../lib/success_criteria_verifier.js');

function run() {
  const proposal = {
    id: 'P-SC-1',
    type: 'collector_remediation',
    action_spec: {
      success_criteria: [
        'Outcome is shipped',
        'duration <= 5s',
        'tokens <= 800',
        'artifact delta >= 1'
      ],
      verify: [
        'Postconditions pass'
      ]
    }
  };

  const rows = parseSuccessCriteriaRows(proposal);
  assert.ok(rows.length >= 5, 'rows should include success_criteria + verify items');

  const ok = evaluateSuccessCriteria(
    proposal,
    {
      outcome: 'shipped',
      exec_ok: true,
      dod_passed: true,
      postconditions_ok: true,
      queue_outcome_logged: true,
      duration_ms: 1400,
      token_usage: { effective_tokens: 620 },
      dod_diff: { artifacts_delta: 2, entries_delta: 1, revenue_actions_delta: 0 }
    },
    { required: true, min_count: 1 }
  );

  assert.strictEqual(ok.required, true);
  assert.strictEqual(ok.passed, true);
  assert.ok(Number(ok.passed_count) >= 4, 'should pass most measurable checks');
  assert.strictEqual(ok.failed_count, 0);

  const fail = evaluateSuccessCriteria(
    proposal,
    {
      outcome: 'no_change',
      exec_ok: true,
      dod_passed: false,
      postconditions_ok: true,
      queue_outcome_logged: true,
      duration_ms: 9200,
      token_usage: { effective_tokens: 1200 },
      dod_diff: { artifacts_delta: 0, entries_delta: 0, revenue_actions_delta: 0 }
    },
    { required: true, min_count: 1 }
  );

  assert.strictEqual(fail.passed, false);
  assert.ok(fail.failed_count >= 1);
  assert.ok(String(fail.primary_failure || '').includes('success_criteria_'));

  const opportunityProposal = {
    id: 'P-SC-2',
    type: 'opportunity_capture',
    action_spec: {
      success_criteria: [
        { metric: 'outreach_artifact', target: '1 concrete offer/proposal draft generated', horizon: '24h' },
        { metric: 'reply_or_interview_count', target: '>=1 reply/interview signal against the draft', horizon: '7d' }
      ]
    }
  };
  const opportunityPass = evaluateSuccessCriteria(
    opportunityProposal,
    {
      outcome: 'shipped',
      exec_ok: true,
      dod_passed: true,
      postconditions_ok: true,
      queue_outcome_logged: true,
      dod_diff: { artifacts_delta: 1 },
      metric_values: { reply_or_interview_count: 2 }
    },
    { required: true, min_count: 1 }
  );
  assert.strictEqual(opportunityPass.passed, true);
  assert.ok(
    opportunityPass.checks.some((c) => c.reason === 'outreach_artifact_check' && c.pass === true),
    'outreach_artifact should evaluate with artifact delta fallback'
  );
  assert.ok(
    opportunityPass.checks.some((c) => c.reason === 'reply_or_interview_count_check' && c.pass === true),
    'reply_or_interview_count should evaluate with metric_values input'
  );

  const opportunityUnknown = evaluateSuccessCriteria(
    opportunityProposal,
    {
      outcome: 'shipped',
      exec_ok: true,
      dod_passed: true,
      postconditions_ok: true,
      queue_outcome_logged: true,
      dod_diff: { artifacts_delta: 1 }
    },
    { required: true, min_count: 1 }
  );
  const replyUnknown = opportunityUnknown.checks.find((c) => c.metric === 'reply_or_interview_count');
  assert.ok(replyUnknown, 'reply_or_interview_count row should exist');
  assert.strictEqual(replyUnknown.evaluated, false, 'reply/interview row should stay unknown without explicit signal');
  assert.strictEqual(replyUnknown.reason, 'reply_or_interview_count_unavailable');

  console.log('success_criteria_verifier.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`success_criteria_verifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

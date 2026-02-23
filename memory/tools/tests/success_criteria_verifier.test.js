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

  const contractRemapped = evaluateSuccessCriteria(
    opportunityProposal,
    {
      capability_key: 'proposal:collector_remediation',
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
  assert.strictEqual(contractRemapped.passed, true, 'proposal remediation lane should remap outreach-only criteria to supported metrics');
  assert.ok(
    contractRemapped.checks.some((c) => c.metric === 'artifact_count'),
    'remapped criteria should include supported artifact_count metric'
  );
  assert.strictEqual(
    Number(contractRemapped.contract && contractRemapped.contract.not_allowed_count || 0),
    0,
    'remapped proposal criteria should avoid capability-metric violations'
  );

  const contractAllowed = evaluateSuccessCriteria(
    opportunityProposal,
    {
      capability_key: 'actuation:moltbook_publish',
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
  assert.strictEqual(contractAllowed.passed, true, 'actuation lane should allow outreach criteria');
  assert.strictEqual(
    Number(contractAllowed.contract && contractAllowed.contract.not_allowed_count || 0),
    0,
    'actuation lane should have zero capability-metric violations'
  );

  const sparseProposal = {
    id: 'P-SC-3',
    type: 'collector_remediation',
    action_spec: {
      success_criteria: [
        { metric: 'execution_success', target: 'execution success' }
      ]
    }
  };
  const sparseBackfilled = evaluateSuccessCriteria(
    sparseProposal,
    {
      capability_key: 'proposal:collector_remediation',
      outcome: 'no_change',
      exec_ok: true,
      dod_passed: false,
      postconditions_ok: true,
      queue_outcome_logged: true
    },
    { required: true, min_count: 2 }
  );
  assert.strictEqual(
    sparseBackfilled.passed,
    true,
    'contract-safe backfill should prevent sparse criteria sets from failing min-count gates'
  );
  assert.ok(
    Number(sparseBackfilled.contract_backfill_count || 0) >= 1,
    'backfill count should report at least one inserted criteria row'
  );
  assert.ok(
    sparseBackfilled.checks.some((c) => c.source === 'contract_backfill'),
    'backfilled checks should be marked with contract_backfill source'
  );

  console.log('success_criteria_verifier.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`success_criteria_verifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

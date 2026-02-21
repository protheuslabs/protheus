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

  console.log('success_criteria_verifier.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`success_criteria_verifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

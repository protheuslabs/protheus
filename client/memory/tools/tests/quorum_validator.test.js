#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { evaluateProposalQuorum } = require('../../../lib/quorum_validator.js');

try {
  let out = evaluateProposalQuorum({
    id: 'Q1',
    type: 'self_modification',
    risk: 'high',
    suggested_next_command: 'node client/systems/security/policy_rootd.js authorize --scope=strategy.mode --dry-run',
    meta: { directive_objective_id: 'T1_goal' },
    action_spec: {
      command: 'node client/systems/security/policy_rootd.js authorize --scope=strategy.mode --dry-run',
      rollback_command: 'git revert --no-edit HEAD'
    },
    success_criteria: [{ metric: 'guard_pass_rate', target: '>= 0.95', horizon: '24h' }]
  });
  assert.strictEqual(out.requires_quorum, true, 'high-tier proposal should require quorum');
  assert.strictEqual(out.ok, true, 'well-formed high-tier proposal should pass quorum');

  out = evaluateProposalQuorum({
    id: 'Q2',
    type: 'self_modification',
    risk: 'high',
    suggested_next_command: 'node client/systems/security/policy_rootd.js authorize --scope=strategy.mode',
    meta: {},
    action_spec: { command: 'node client/systems/security/policy_rootd.js authorize --scope=strategy.mode' },
    success_criteria: []
  });
  assert.strictEqual(out.requires_quorum, true, 'high-tier proposal should require quorum');
  assert.strictEqual(out.ok, false, 'missing objective/rollback/success criteria should fail');
  assert.ok(out.reason === 'validator_disagreement' || out.reason === 'validators_denied', 'expected deterministic quorum failure reason');

  console.log('quorum_validator.test.js: OK');
} catch (err) {
  console.error(`quorum_validator.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

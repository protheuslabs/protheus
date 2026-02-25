#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars || {})) {
    prev[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars || {})) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadController(vars = {}) {
  return withEnv(vars, () => {
    delete require.cache[require.resolve(CONTROLLER_PATH)];
    return require(CONTROLLER_PATH);
  });
}

function run() {
  const controller = loadController({
    AUTONOMY_REQUIRE_ADMISSION_PREVIEW: '1',
    AUTONOMY_MUTATION_EXECUTION_GUARD_REQUIRED: '1'
  });
  const permissiveStrategy = {
    risk_policy: { max_risk_per_action: 100 },
    admission_policy: {}
  };

  const blockedByPreview = controller.strategyAdmissionDecision({
    id: 'P_ADM_BLOCK',
    type: 'unknown',
    meta: {
      admission_preview: {
        eligible: false,
        blocked_by: ['risk_not_allowed']
      }
    }
  }, permissiveStrategy, {});
  assert.strictEqual(blockedByPreview.allow, false, 'admission preview blocked proposal should not be admitted');
  assert.strictEqual(blockedByPreview.reason, 'risk_not_allowed', 'admission block should preserve blocker reason');

  const mutationMissingGuard = controller.strategyAdmissionDecision({
    id: 'P_MUTATION_MISSING',
    type: 'adaptive_topology_mutation',
    title: 'Adaptive mutation without execution receipts',
    suggested_next_command: 'node systems/routing/route_execute.js --task="mutation rewire test" --dry-run',
    meta: {
      admission_preview: {
        eligible: true,
        blocked_by: []
      }
    }
  }, permissiveStrategy, {});
  assert.strictEqual(mutationMissingGuard.allow, false, 'mutation proposal without guard metadata should fail closed');
  assert.strictEqual(
    mutationMissingGuard.reason,
    'adaptive_mutation_guard_metadata_missing',
    'missing mutation guard metadata should be first block reason'
  );

  const mutationGuardDecision = controller.adaptiveMutationExecutionGuardDecision({
    id: 'P_MUTATION_KERNEL_FAIL',
    type: 'adaptive_topology_mutation',
    meta: {
      adaptive_mutation_guard_applies: true,
      adaptive_mutation_guard_pass: true,
      adaptive_mutation_guard_controls: {
        safety_attestation: 'attest_001',
        rollback_receipt: 'rollback_001',
        guard_receipt_id: 'mut_guard_P_MUTATION_KERNEL_FAIL',
        mutation_kernel_applies: true,
        mutation_kernel_pass: false
      }
    }
  });
  assert.strictEqual(mutationGuardDecision.applies, true, 'mutation signal should apply guard');
  assert.strictEqual(mutationGuardDecision.pass, false, 'kernel failure should block guard decision');
  assert.ok(
    Array.isArray(mutationGuardDecision.reasons) && mutationGuardDecision.reasons.includes('adaptive_mutation_kernel_failed'),
    'kernel failure reason should be present'
  );

  const mutationPass = controller.strategyAdmissionDecision({
    id: 'P_MUTATION_PASS',
    type: 'adaptive_topology_mutation',
    meta: {
      admission_preview: {
        eligible: true,
        blocked_by: []
      },
      adaptive_mutation_guard_applies: true,
      adaptive_mutation_guard_pass: true,
      adaptive_mutation_guard_controls: {
        safety_attestation: 'attest_pass_001',
        rollback_receipt: 'rollback_pass_001',
        guard_receipt_id: 'mut_guard_P_MUTATION_PASS',
        mutation_kernel_applies: true,
        mutation_kernel_pass: true
      }
    }
  }, permissiveStrategy, {});
  assert.strictEqual(mutationPass.allow, true, 'mutation proposal with full guard controls should be admitted');

  console.log('autonomy_mutation_execution_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_mutation_execution_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

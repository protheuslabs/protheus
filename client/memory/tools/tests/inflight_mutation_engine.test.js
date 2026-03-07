#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  candidateMutationOrder,
  applyMutationKind,
  evaluateMutationGate
} = require('../../../systems/workflow/inflight_mutation_engine.js');

function run() {
  const policy = {
    allow: {
      retry_tuning: true,
      guard_hardening: true,
      rollback_path: true
    },
    max_retry_increment: 1,
    max_total_retry_per_step: 3,
    max_attempts_per_kind: 2,
    veto_window_sec: 60,
    require_safety_attestation: true,
    require_human_veto_for_high_impact: true,
    high_impact_levels: ['high', 'critical']
  };

  const steps = [
    { id: 'step_main', type: 'command', command: 'node -e "process.exit(1)"', retries: 0, timeout_ms: 30000 },
    { id: 'receipt', type: 'receipt', command: 'state/out.json', retries: 0, timeout_ms: 30000 }
  ];

  const order = candidateMutationOrder(
    { mutation: { kind: 'retry_tuning' } },
    steps[0],
    policy,
    { by_kind: { retry_tuning: 0, guard_hardening: 0, rollback_path: 0 } }
  );
  assert.deepStrictEqual(order, ['retry_tuning', 'guard_hardening', 'rollback_path']);

  const retryPatch = applyMutationKind('retry_tuning', steps, 0, policy);
  assert.strictEqual(retryPatch.ok, true);
  assert.strictEqual(retryPatch.changed, true);
  assert.strictEqual(retryPatch.steps[0].retries, 1);

  const guardPatch = applyMutationKind('guard_hardening', steps, 0, policy);
  assert.strictEqual(guardPatch.ok, true);
  assert.strictEqual(guardPatch.changed, true);
  assert.strictEqual(guardPatch.steps[0].id, 'preflight_runtime_guard');

  const rollbackPatch = applyMutationKind('rollback_path', steps, 0, policy);
  assert.strictEqual(rollbackPatch.ok, true);
  assert.strictEqual(rollbackPatch.changed, true);
  assert.ok(
    rollbackPatch.steps.some((row) => String(row.id || '').includes('rollback_runtime')),
    'rollback patch should inject rollback step'
  );

  const gateBlocked = evaluateMutationGate({
    now_ts: '2026-02-26T10:00:00.000Z',
    last_failure_ts: '2026-02-26T09:59:30.000Z',
    objective_impact: 'critical',
    safety_attested: false,
    human_veto_cleared: false
  }, policy);
  assert.strictEqual(gateBlocked.allowed, false);
  assert.ok(gateBlocked.reasons.includes('within_veto_window'));
  assert.ok(gateBlocked.reasons.includes('missing_safety_attestation'));
  assert.ok(gateBlocked.reasons.includes('high_impact_requires_human_veto_clearance'));

  const gateAllowed = evaluateMutationGate({
    now_ts: '2026-02-26T12:00:00.000Z',
    last_failure_ts: '2026-02-26T09:59:30.000Z',
    objective_impact: 'medium',
    safety_attested: true,
    human_veto_cleared: false
  }, policy);
  assert.strictEqual(gateAllowed.allowed, true);
}

run();

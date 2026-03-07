#!/usr/bin/env node
'use strict';
export {};

const { parseArgs, loadPolicy, emit } = require('./_shared');
const tracker = require('./gpu_contribution_tracker');
const oracle = require('./contribution_oracle');
const engine = require('./tithe_engine');

function runHarness(policy: Record<string, any>, donorId: string, gpuHours: number) {
  const contribution = tracker.recordContribution(policy, {
    donor_id: donorId,
    gpu_hours: gpuHours,
    proof_ref: `sim://${donorId}/${Date.now()}`
  });
  const validation = oracle.validateContribution(contribution);
  if (!validation.validated) {
    return {
      ok: false,
      stage: 'validation',
      contribution,
      validation
    };
  }
  tracker.updateContributionStatus(policy, contribution.contribution_id, 'validated', {
    validation_id: validation.validation_id,
    validated_gpu_hours: validation.validated_gpu_hours
  });
  const applied = engine.applyDiscountAndRecord(policy, {
    donor_id: contribution.donor_id,
    contribution_id: contribution.contribution_id,
    validated_gpu_hours: validation.validated_gpu_hours
  });
  if (!applied || applied.ok !== true) {
    return {
      ok: false,
      stage: 'apply_failed',
      contribution,
      validation,
      applied
    };
  }
  const donorState = engine.loadDonorState(policy)[donorId] || null;
  const nextActuation = engine.previewNextActuation(policy, donorState || {}, Number(applied.risk_tier || 2));
  const ok = !!(
    applied
    && donorState
    && Number(donorState.effective_tithe_rate || 1) < Number(policy.base_tithe_rate || 0.1)
    && Number(nextActuation.effective_tithe_rate || 1) === Number(donorState.effective_tithe_rate || 0)
  );
  return {
    ok,
    stage: ok ? 'complete' : 'apply_failed',
    contribution,
    validation,
    applied,
    donor_state: donorState,
    next_actuation: nextActuation
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const donorId = String(args.donor_id || args.donor || 'sim_donor').trim() || 'sim_donor';
  const gpuHours = Math.max(0.001, Number(args.gpu_hours || args.hours || 240));
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  const out = runHarness(policy, donorId, gpuHours);
  emit({
    type: 'compute_tithe_acceptance_harness',
    policy_enabled: policy.enabled === true,
    ...out
  }, out.ok ? 0 : 2);
}

module.exports = {
  runHarness
};

if (require.main === module) {
  main();
}

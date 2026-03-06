#!/usr/bin/env node
'use strict';
export {};

const {
  parseArgs,
  loadPolicy,
  emit,
  rel,
  stableHash,
  cleanText
} = require('./_shared');
const tracker = require('./gpu_contribution_tracker');
const oracle = require('./contribution_oracle');
const engine = require('./tithe_engine');

function usage() {
  console.log('Usage:');
  console.log('  node systems/economy/public_donation_api.js register --donor_id=<id>');
  console.log('  node systems/economy/public_donation_api.js donate --donor_id=<id> --gpu_hours=<n> --proof_ref=<ref>');
  console.log('  node systems/economy/public_donation_api.js status [--donor_id=<id>]');
}

function registrationToken(donorId: string) {
  return `gpu_reg_${stableHash(`donor:${cleanText(donorId, 160)}`, 20)}`;
}

function cmdRegister(args: Record<string, any>) {
  const donorId = String(args.donor_id || args.donor || '').trim();
  if (!donorId) emit({ ok: false, error: 'donor_id_required' }, 2);
  emit({
    ok: true,
    type: 'compute_tithe_donation_register',
    donor_id: donorId,
    registration_token: registrationToken(donorId)
  }, 0);
}

function cmdDonate(policy: Record<string, any>, args: Record<string, any>) {
  const contribution = tracker.recordContribution(policy, args);
  const validation = oracle.validateContribution(contribution);
  if (!validation.validated) {
    tracker.updateContributionStatus(policy, contribution.contribution_id, 'rejected', {
      validation_errors: validation.errors
    });
    emit({
      ok: false,
      type: 'compute_tithe_donation',
      policy_path: rel(policy.policy_path),
      contribution,
      validation
    }, 2);
  }
  tracker.updateContributionStatus(policy, contribution.contribution_id, 'validated', {
    validation_id: validation.validation_id,
    validated_gpu_hours: validation.validated_gpu_hours
  });
  const apply = engine.applyDiscountAndRecord(policy, {
    donor_id: contribution.donor_id,
    contribution_id: contribution.contribution_id,
    validated_gpu_hours: validation.validated_gpu_hours
  });
  if (!apply || apply.ok !== true) {
    tracker.updateContributionStatus(policy, contribution.contribution_id, 'apply_failed', {
      apply_error: apply && apply.error ? String(apply.error) : 'unknown_apply_error'
    });
    emit({
      ok: false,
      type: 'compute_tithe_donation',
      policy_path: rel(policy.policy_path),
      contribution,
      validation,
      applied: apply
    }, 2);
  }
  emit({
    ok: true,
    type: 'compute_tithe_donation',
    policy_path: rel(policy.policy_path),
    registration_token: registrationToken(contribution.donor_id),
    contribution,
    validation,
    applied: apply
  }, 0);
}

function cmdStatus(policy: Record<string, any>, args: Record<string, any>) {
  const state = engine.loadDonorState(policy);
  const donorId = String(args.donor_id || args.donor || '').trim();
  if (donorId) {
    emit({ ok: true, type: 'compute_tithe_donation_status', donor_id: donorId, donor_state: state[donorId] || null }, 0);
  }
  emit({ ok: true, type: 'compute_tithe_donation_status', donor_count: Object.keys(state).length, donor_state: state }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    emit({ ok: false, type: 'compute_tithe_donation', error: 'policy_disabled' }, 2);
  }
  if (cmd === 'register') return cmdRegister(args);
  if (cmd === 'donate') return cmdDonate(policy, args);
  if (cmd === 'status') return cmdStatus(policy, args);
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

if (require.main === module) {
  main();
}

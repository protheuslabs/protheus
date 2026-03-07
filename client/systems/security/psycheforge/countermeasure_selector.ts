#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  clampInt
} = require('./_shared');

function resolveRiskTier(profile: Record<string, any>, policy: Record<string, any>) {
  const base = clampInt(policy && policy.default_risk_tier, 1, 4, 2);
  const cls = String(profile && profile.behavior_class ? profile.behavior_class : '').toLowerCase();
  const features = profile && profile.features && typeof profile.features === 'object' ? profile.features : {};
  const escalation = Number(features.escalation_attempts || 0);
  const probeDensity = Number(features.probe_density || 0);
  const signatureFailures = Number(features.signature_failures || 0);

  let tier = base;
  if (['aggressive', 'nation_state'].includes(cls)) tier = Math.max(tier, 3);
  if (cls === 'script_kiddie' && signatureFailures >= 10) tier = Math.max(tier, 3);
  if (escalation >= 14 || probeDensity >= 0.85) tier = Math.max(tier, 4);
  return Math.max(1, Math.min(4, tier));
}

function selectCountermeasure(profile: Record<string, any>, policy: Record<string, any>, options: Record<string, any> = {}) {
  const riskTier = resolveRiskTier(profile, policy);
  const activationTier = clampInt(policy && policy.activation_tier_threshold, 1, 4, 3);
  const requiresTwoGate = riskTier >= activationTier;
  const twoGateApproved = options.two_gate_approved === true;

  const passive = ['rate_limit', 'proof_of_work_challenge', 'deception_hint'];
  const active = ['isolated_quarantine', 'venom_containment_boost', 'fractal_guard_lock'];
  const selected = requiresTwoGate ? active : passive;
  const stage = requiresTwoGate
    ? (twoGateApproved ? 'live' : 'shadow')
    : (options.apply === true ? 'live' : 'shadow');

  return {
    schema_id: 'psycheforge_countermeasure_decision',
    schema_version: '1.0',
    decided_at: nowIso(),
    decision_id: `psy_dec_${Date.now().toString(36)}`,
    behavior_class: profile && profile.behavior_class ? profile.behavior_class : 'unknown',
    behavior_confidence: Number(profile && profile.behavior_confidence || 0),
    risk_tier: riskTier,
    activation_tier_threshold: activationTier,
    requires_two_gate: requiresTwoGate,
    two_gate_approved: twoGateApproved,
    stage,
    selected_countermeasures: selected,
    integration_targets: ['guard', 'redteam', 'venom', 'fractal']
  };
}

module.exports = {
  selectCountermeasure
};

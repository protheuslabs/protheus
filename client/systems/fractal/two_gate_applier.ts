#!/usr/bin/env node
'use strict';
export {};

/**
 * Two-gate applier for fractal mutations.
 *
 * Gate 1: risk + shadow-pass + constitution checks.
 * Gate 2: remote/human approvals with explicit tier escalation rules.
 */

const {
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber
} = require('../../lib/queued_backlog_runtime');

function approve(candidate: any, trialResult: any, options: any = {}) {
  const requestedTier = clampInt(
    options.tier != null ? options.tier : candidate && candidate.risk_tier,
    0,
    9,
    2
  );
  const passRate = clampNumber(trialResult && trialResult.passRate, 0, 1, 0);
  const confidenceThreshold = clampNumber(options.confidence_threshold, 0, 1, 0.997);
  const maxTierBeforeConfidence = clampInt(options.max_tier_before_confidence, 0, 9, 2);

  const constitutionPass = !(candidate && candidate.constitution && candidate.constitution.pass === false);
  const gate1 = {
    shadow_pass_rate_ok: passRate >= confidenceThreshold,
    tier_within_confidence_guard: requestedTier <= maxTierBeforeConfidence || passRate >= confidenceThreshold,
    constitution_pass: constitutionPass
  };

  const requireHumanGate = requestedTier >= 3;
  const humanApprovalId = cleanText(
    options.humanApprovalId
    || options.human_approval_id
    || process.env.FRACTAL_HUMAN_GATE_APPROVAL_ID
    || '',
    120
  );
  const remoteApproved = toBool(
    options.remoteApproved != null ? options.remoteApproved : process.env.FRACTAL_REMOTE_GATE_APPROVED,
    requestedTier <= 2
  );

  const gate2 = {
    remote_gate_pass: remoteApproved,
    human_gate_pass: requireHumanGate ? humanApprovalId.length > 0 : true
  };

  const approved = Object.values(gate1).every(Boolean) && Object.values(gate2).every(Boolean);
  const reasons = [];
  if (!gate1.shadow_pass_rate_ok) reasons.push('shadow_pass_rate_below_threshold');
  if (!gate1.tier_within_confidence_guard) reasons.push('tier_exceeds_confidence_guard');
  if (!gate1.constitution_pass) reasons.push('constitution_gate_failed');
  if (!gate2.remote_gate_pass) reasons.push('remote_gate_missing');
  if (!gate2.human_gate_pass) reasons.push('human_gate_missing_for_tier3_plus');

  return {
    approved,
    type: 'fractal_two_gate_decision',
    ts: nowIso(),
    tier: requestedTier,
    pass_rate: Number(passRate.toFixed(6)),
    confidence_threshold: confidenceThreshold,
    require_human_gate: requireHumanGate,
    human_approval_id: humanApprovalId || null,
    gates: {
      gate1,
      gate2
    },
    reasons
  };
}

module.exports = {
  approve
};

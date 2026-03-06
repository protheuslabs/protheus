#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;
let admitStrandCandidate = null;
try {
  ({ admitStrandCandidate } = require('../helix/helix_admission_gate.js'));
} catch {
  admitStrandCandidate = null;
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function evaluateGraftDecision(input: AnyObj = {}, policy: AnyObj = {}) {
  const capabilityId = normalizeToken(input.capability_id || '', 160) || 'unknown_capability';
  const riskClass = normalizeToken(input.risk_class || '', 64) || 'general';
  const applyRequested = input.apply_requested === true;
  const humanApproved = input.human_approved === true;
  const legalAllowed = !!(input.legal_gate && input.legal_gate.allowed === true);
  const constitutionClear = !!(input.constitutional_veto && input.constitutional_veto.blocked !== true);
  const researchFit = !!(input.research_probe && input.research_probe.fit === 'sufficient');
  const nurseryPass = !!(input.nursery && input.nursery.passed === true);
  const adversarialPass = !!(input.adversarial && input.adversarial.passed === true);
  const strandCandidate = input && input.strand_candidate && typeof input.strand_candidate === 'object'
    ? input.strand_candidate
    : (input && input.forge_replica && input.forge_replica.strand_candidate && typeof input.forge_replica.strand_candidate === 'object'
      ? input.forge_replica.strand_candidate
      : null);
  const shadowOnly = policy.shadow_only !== false;
  const allowApply = policy.allow_apply === true;
  const ttlCfg = policy.ttl && typeof policy.ttl === 'object' ? policy.ttl : {};
  const ttlDays = clampInt(ttlCfg.default_days, 1, 3650, 14);
  const highRiskCfg = policy.risk_classes && typeof policy.risk_classes === 'object'
    ? policy.risk_classes
    : {};
  const highRisk = new Set(
    Array.isArray(highRiskCfg.high_risk)
      ? highRiskCfg.high_risk.map((v: unknown) => normalizeToken(v, 64)).filter(Boolean)
      : ['payments', 'auth', 'filesystem', 'shell', 'network-control']
  );
  const requireHumanForHighRisk = highRiskCfg.require_explicit_human_approval !== false;

  const reasons: string[] = [];
  let blocked = false;
  if (!legalAllowed) {
    blocked = true;
    reasons.push('graft_blocked_legal_gate');
  }
  if (!constitutionClear) {
    blocked = true;
    reasons.push('graft_blocked_constitutional_veto');
  }
  if (!researchFit) {
    blocked = true;
    reasons.push('graft_blocked_research_fit');
  }
  if (!nurseryPass) {
    blocked = true;
    reasons.push('graft_blocked_nursery');
  }
  if (!adversarialPass) {
    blocked = true;
    reasons.push('graft_blocked_adversarial');
  }
  if (requireHumanForHighRisk && highRisk.has(riskClass) && !humanApproved) {
    blocked = true;
    reasons.push('graft_blocked_high_risk_requires_human_approval');
  }

  const helixApplyRequested = applyRequested && !shadowOnly && allowApply;
  let helixAdmission = null;
  if (typeof admitStrandCandidate === 'function' && strandCandidate) {
    helixAdmission = admitStrandCandidate({
      candidate: strandCandidate,
      apply_requested: helixApplyRequested,
      doctor_approved: humanApproved
    });
    if (!helixAdmission || helixAdmission.allowed !== true) {
      blocked = true;
      reasons.push('graft_blocked_helix_admission');
      if (helixAdmission && Array.isArray(helixAdmission.reason_codes)) {
        reasons.push(...helixAdmission.reason_codes.map((v: unknown) => normalizeToken(v, 120)).filter(Boolean));
      }
    }
  } else if (applyRequested) {
    blocked = true;
    reasons.push('graft_blocked_helix_admission_missing');
  }

  if (shadowOnly) reasons.push('shadow_only_mode');
  if (!allowApply) reasons.push('apply_disabled_by_policy');
  if (applyRequested && helixAdmission && helixAdmission.apply_executed !== true) {
    reasons.push('helix_admission_apply_not_executed');
  }

  const helixApplyOk = helixAdmission
    ? (applyRequested ? helixAdmission.apply_executed === true : true)
    : true;
  const applyExecutable = applyRequested && !shadowOnly && allowApply && !blocked && helixApplyOk;
  const mode = applyExecutable ? 'ttl' : 'shadow';
  const rollbackCommand = `node systems/assimilation/assimilation_controller.js rollback --capability-id=${capabilityId}`;

  return {
    capability_id: capabilityId,
    blocked,
    apply_requested: applyRequested,
    apply_executed: applyExecutable,
    mode,
    ttl_days: mode === 'ttl' ? ttlDays : 0,
    reason_codes: reasons,
    strand_candidate: strandCandidate,
    helix_admission: helixAdmission,
    rollback_plan: {
      reversible: true,
      atomic: true,
      command: rollbackCommand
    }
  };
}

module.exports = {
  evaluateGraftDecision
};

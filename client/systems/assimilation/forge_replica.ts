#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;
const crypto = require('crypto');
let buildStrandCandidate = null;
try {
  ({ buildStrandCandidate } = require('../helix/helix_admission_gate.js'));
} catch {
  buildStrandCandidate = null;
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

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 16);
}

function buildForgeReplica(input: AnyObj = {}, policy: AnyObj = {}) {
  const capabilityId = normalizeToken(input.capability_id || '', 160) || 'unknown_capability';
  const sourceType = normalizeToken(input.source_type || '', 64) || 'external_tool';
  const riskClass = normalizeToken(input.risk_class || '', 64) || 'general';
  const mode = normalizeToken(input.mode || '', 64) || 'shadow';
  const nowTs = String(input.now_ts || new Date().toISOString());
  const seed = `${capabilityId}|${sourceType}|${riskClass}|${nowTs}`;
  const replicaId = `rep_${sha16(seed)}`;
  const profile = policy && policy.forge && typeof policy.forge === 'object'
    ? policy.forge
    : {};
  const sandboxProfile = normalizeToken(profile.sandbox_profile || 'strict_isolated', 80) || 'strict_isolated';
  const maxBuildSteps = Math.max(3, Math.min(32, Number(profile.max_build_steps || 8)));

  const buildSteps = [
    {
      id: 'contract_scaffold',
      note: 'Create typed adapter contract from observed behavior surface.'
    },
    {
      id: 'auth_boundary',
      note: 'Implement explicit auth boundary and secret-handle interface.'
    },
    {
      id: 'rate_limit_guard',
      note: 'Embed deterministic rate-limit + retry policy.'
    },
    {
      id: 'observability_receipts',
      note: 'Emit structured receipts for all side effects.'
    },
    {
      id: 'rollback_hook',
      note: 'Prepare one-command rollback + disable path.'
    }
  ].slice(0, maxBuildSteps);

  const strandCandidate = typeof buildStrandCandidate === 'function'
    ? buildStrandCandidate({
      source: normalizeToken(input.source || 'assimilation', 80) || 'assimilation',
      capability_id: capabilityId,
      risk_class: riskClass,
      mode,
      replica_id: replicaId
    })
    : null;

  return {
    replica_id: replicaId,
    capability_id: capabilityId,
    source_type: sourceType,
    risk_class: riskClass,
    mode,
    clean_room_attestation: {
      required: true,
      asserted: true,
      note: 'Behavior replication plan only; no proprietary code ingestion.'
    },
    sandbox_profile: sandboxProfile,
    build_steps: buildSteps,
    artifacts: {
      planned_contract_path: `systems/assimilation/generated/${replicaId}/contract.ts`,
      planned_adapter_path: `systems/assimilation/generated/${replicaId}/adapter.ts`
    },
    strand_candidate: strandCandidate,
    reason_codes: ['forge_replica_planned', 'clean_room_mode']
  };
}

module.exports = {
  buildForgeReplica
};

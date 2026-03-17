#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createOpsLaneBridge } = require('../runtime/lib/rust_lane_bridge.ts');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'local', 'state', 'adaptive', 'strategy', 'outcome_fitness.json');

const THRESHOLD_KEYS = new Set([
  'min_signal_quality',
  'min_sensory_signal_score',
  'min_sensory_relevance_score',
  'min_directive_fit',
  'min_actionability_score',
  'min_eye_score_ema',
  'min_composite_eligibility'
]);

const RANKING_WEIGHT_KEYS = new Set([
  'composite',
  'actionability',
  'directive_fit',
  'signal_quality',
  'expected_value',
  'time_to_value',
  'risk_penalty'
]);

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'outcome_fitness', 'outcome-fitness-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `outcome_fitness_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `outcome_fitness_kernel_${command}_failed`);
    return { ok: false, error: message || `outcome_fitness_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `outcome_fitness_kernel_${command}_bridge_failed`
      : `outcome_fitness_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function normalizeThresholdOverrides(raw) {
  const out = invoke('normalize-threshold-overrides', raw && typeof raw === 'object' ? raw : {});
  return out.normalized && typeof out.normalized === 'object' ? out.normalized : {};
}

function normalizeRankingWeights(raw) {
  const out = invoke('normalize-ranking-weights', raw && typeof raw === 'object' ? raw : {});
  return out.normalized && typeof out.normalized === 'object' ? out.normalized : null;
}

function normalizeProposalTypeThresholdOffsets(raw) {
  const out = invoke(
    'normalize-proposal-type-threshold-offsets',
    raw && typeof raw === 'object' ? raw : {}
  );
  return out.normalized && typeof out.normalized === 'object' ? out.normalized : {};
}

function normalizePromotionPolicyOverrides(raw) {
  const out = invoke(
    'normalize-promotion-policy-overrides',
    raw && typeof raw === 'object' ? raw : {}
  );
  return out.normalized && typeof out.normalized === 'object' ? out.normalized : {};
}

function normalizeValueCurrencyPolicyOverrides(raw) {
  const out = invoke(
    'normalize-value-currency-policy-overrides',
    raw && typeof raw === 'object' ? raw : {}
  );
  return out.normalized && typeof out.normalized === 'object'
    ? out.normalized
    : {
        default_currency: null,
        currency_overrides: {},
        objective_overrides: {}
      };
}

function normalizeProposalTypeKey(v) {
  const out = invoke('normalize-proposal-type-key', { value: v });
  return String(out.normalized || '').trim();
}

function normalizeValueCurrencyToken(v) {
  const out = invoke('normalize-value-currency-token', { value: v });
  return String(out.normalized || '').trim();
}

function proposalTypeThresholdOffsetsFor(policy, proposalType) {
  const out = invoke('proposal-type-threshold-offsets-for', {
    policy: policy && typeof policy === 'object' ? policy : {},
    proposal_type: proposalType
  });
  return out.offsets && typeof out.offsets === 'object' ? out.offsets : {};
}

function loadOutcomeFitnessPolicy(rootDir = REPO_ROOT, overridePath = null) {
  return invoke('load-policy', {
    root_dir: rootDir,
    override_path: overridePath
  });
}

module.exports = {
  DEFAULT_POLICY_PATH,
  THRESHOLD_KEYS,
  RANKING_WEIGHT_KEYS,
  loadOutcomeFitnessPolicy,
  normalizeThresholdOverrides,
  normalizeRankingWeights,
  normalizeProposalTypeThresholdOffsets,
  normalizePromotionPolicyOverrides,
  normalizeValueCurrencyPolicyOverrides,
  normalizeProposalTypeKey,
  normalizeValueCurrencyToken,
  proposalTypeThresholdOffsetsFor
};

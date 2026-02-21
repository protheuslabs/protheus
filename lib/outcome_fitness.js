'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'outcome_fitness.json');

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

function normalizeProposalTypeKey(v) {
  const key = String(v || '').trim().toLowerCase();
  if (!key) return '';
  return key
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeThresholdOverrides(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (!THRESHOLD_KEYS.has(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

function normalizeRankingWeights(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  let total = 0;
  for (const key of RANKING_WEIGHT_KEYS) {
    const n = Number(src[key]);
    if (!Number.isFinite(n) || n < 0) continue;
    out[key] = n;
    total += n;
  }
  if (total <= 0) return null;
  const normalized = {};
  for (const [key, value] of Object.entries(out)) {
    normalized[key] = Number((value / total).toFixed(6));
  }
  return normalized;
}

function normalizeProposalTypeThresholdOffsets(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [typeKeyRaw, value] of Object.entries(src)) {
    const typeKey = normalizeProposalTypeKey(typeKeyRaw);
    if (!typeKey) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const normalized = normalizeThresholdOverrides(value);
    if (!Object.keys(normalized).length) continue;
    out[typeKey] = normalized;
  }
  return out;
}

function proposalTypeThresholdOffsetsFor(policy, proposalType) {
  const typeKey = normalizeProposalTypeKey(proposalType);
  if (!typeKey) return {};
  const strategyPolicy = policy && policy.strategy_policy && typeof policy.strategy_policy === 'object'
    ? policy.strategy_policy
    : {};
  const table = strategyPolicy.proposal_type_threshold_offsets && typeof strategyPolicy.proposal_type_threshold_offsets === 'object'
    ? strategyPolicy.proposal_type_threshold_offsets
    : {};
  const row = table[typeKey];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  return normalizeThresholdOverrides(row);
}

function loadOutcomeFitnessPolicy(rootDir = REPO_ROOT, overridePath = null) {
  const envPath = String(process.env.OUTCOME_FITNESS_POLICY_PATH || '').trim();
  const filePath = overridePath
    ? path.resolve(String(overridePath))
    : (envPath
      ? path.resolve(envPath)
      : path.join(path.resolve(String(rootDir || REPO_ROOT)), 'state', 'adaptive', 'strategy', 'outcome_fitness.json'));
  const raw = readJsonSafe(filePath, null);
  const strategyPolicy = raw && raw.strategy_policy && typeof raw.strategy_policy === 'object'
    ? raw.strategy_policy
    : {};
  const focusPolicy = raw && raw.focus_policy && typeof raw.focus_policy === 'object'
    ? raw.focus_policy
    : {};
  const filterPolicy = raw && raw.proposal_filter_policy && typeof raw.proposal_filter_policy === 'object'
    ? raw.proposal_filter_policy
    : {};

  return {
    found: !!raw,
    path: filePath,
    ts: raw && raw.ts ? String(raw.ts) : null,
    realized_outcome_score: clampNumber(raw && raw.realized_outcome_score, 0, 100, null),
    strategy_policy: {
      strategy_id: String(strategyPolicy.strategy_id || '').trim() || null,
      threshold_overrides: normalizeThresholdOverrides(strategyPolicy.threshold_overrides),
      ranking_weights_override: normalizeRankingWeights(strategyPolicy.ranking_weights_override),
      proposal_type_threshold_offsets: normalizeProposalTypeThresholdOffsets(strategyPolicy.proposal_type_threshold_offsets)
    },
    focus_policy: {
      min_focus_score_delta: clampInt(focusPolicy.min_focus_score_delta, -20, 20, 0)
    },
    proposal_filter_policy: {
      require_success_criteria: filterPolicy.require_success_criteria !== false,
      min_success_criteria_count: clampInt(filterPolicy.min_success_criteria_count, 0, 5, 1)
    }
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  THRESHOLD_KEYS,
  RANKING_WEIGHT_KEYS,
  loadOutcomeFitnessPolicy,
  normalizeThresholdOverrides,
  normalizeRankingWeights,
  normalizeProposalTypeThresholdOffsets,
  normalizeProposalTypeKey,
  proposalTypeThresholdOffsetsFor
};

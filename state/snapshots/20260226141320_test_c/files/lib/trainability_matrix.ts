'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = process.env.TRAINABILITY_MATRIX_POLICY_PATH
  ? path.resolve(String(process.env.TRAINABILITY_MATRIX_POLICY_PATH))
  : path.join(REPO_ROOT, 'config', 'trainability_matrix_policy.json');

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function cleanText(v, maxLen = 180) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTokenList(v, maxLen = 120) {
  return Array.from(
    new Set((Array.isArray(v) ? v : [])
      .map((row) => normalizeToken(row, maxLen))
      .filter(Boolean))
  );
}

function defaultPolicy() {
  return {
    version: '1.0',
    default_allow: false,
    require_consent_granted: true,
    provider_rules: {
      internal: {
        allow: true,
        allowed_license_ids: ['internal_protheus'],
        allowed_consent_modes: ['operator_policy', 'internal_system', 'explicit_opt_in'],
        note: 'Internal first-party data retained by local operator policy.'
      }
    }
  };
}

function normalizeRule(rule = {}) {
  const src = rule && typeof rule === 'object' ? rule : {};
  return {
    allow: src.allow === true,
    allowed_license_ids: normalizeTokenList(src.allowed_license_ids, 160),
    allowed_consent_modes: normalizeTokenList(src.allowed_consent_modes, 120),
    note: cleanText(src.note || '', 220) || null
  };
}

function normalizePolicy(raw) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const providerRulesRaw = src.provider_rules && typeof src.provider_rules === 'object'
    ? src.provider_rules
    : base.provider_rules;
  const providerRules = {};
  for (const [provider, rule] of Object.entries(providerRulesRaw)) {
    const key = normalizeToken(provider, 120);
    if (!key) continue;
    providerRules[key] = normalizeRule(rule);
  }
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    default_allow: src.default_allow === true,
    require_consent_granted: src.require_consent_granted !== false,
    provider_rules: providerRules
  };
}

function loadTrainabilityMatrixPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJsonSafe(policyPath, defaultPolicy()));
}

function evaluateTrainingDatumTrainability(metadata, policyInput = null) {
  const policy = normalizePolicy(policyInput || loadTrainabilityMatrixPolicy());
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  const source = m.source && typeof m.source === 'object' ? m.source : {};
  const license = m.license && typeof m.license === 'object' ? m.license : {};
  const consent = m.consent && typeof m.consent === 'object' ? m.consent : {};
  const provider = normalizeToken(source.provider || 'unknown', 120) || 'unknown';
  const rule = policy.provider_rules && policy.provider_rules[provider]
    ? policy.provider_rules[provider]
    : null;
  const consentStatus = normalizeToken(consent.status || 'unknown', 40) || 'unknown';
  const consentMode = normalizeToken(consent.mode || 'unknown', 120) || 'unknown';
  const licenseId = normalizeToken(license.id || '', 160) || null;

  const checks = {
    provider_known: rule != null,
    provider_allowed: rule != null ? rule.allow === true : policy.default_allow === true,
    consent_granted: consentStatus === 'granted',
    license_allowed: true,
    consent_mode_allowed: true
  };

  if (rule && Array.isArray(rule.allowed_license_ids) && rule.allowed_license_ids.length > 0) {
    checks.license_allowed = licenseId != null && rule.allowed_license_ids.includes(licenseId);
  }
  if (rule && Array.isArray(rule.allowed_consent_modes) && rule.allowed_consent_modes.length > 0) {
    checks.consent_mode_allowed = rule.allowed_consent_modes.includes(consentMode);
  }

  const reasons = [];
  if (!checks.provider_known && policy.default_allow !== true) reasons.push('unknown_provider_default_deny');
  if (!checks.provider_allowed) reasons.push('provider_terms_deny');
  if (policy.require_consent_granted && !checks.consent_granted) reasons.push('consent_not_granted');
  if (!checks.license_allowed) reasons.push('license_not_allowlisted');
  if (!checks.consent_mode_allowed) reasons.push('consent_mode_not_allowlisted');

  return {
    allow: reasons.length === 0,
    provider,
    policy_version: policy.version,
    reason: reasons.length ? reasons[0] : 'allow',
    reasons,
    checks
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  defaultPolicy,
  normalizePolicy,
  loadTrainabilityMatrixPolicy,
  evaluateTrainingDatumTrainability
};

export {};

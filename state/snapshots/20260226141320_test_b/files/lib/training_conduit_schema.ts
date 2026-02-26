'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = process.env.TRAINING_CONDUIT_POLICY_PATH
  ? path.resolve(String(process.env.TRAINING_CONDUIT_POLICY_PATH))
  : path.join(REPO_ROOT, 'config', 'training_conduit_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function cleanText(v, maxLen = 200) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function relPath(v) {
  const raw = cleanText(v, 400);
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  return path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
}

function normalizeConsentStatus(v, fallback = 'unknown') {
  const token = normalizeToken(v, 40);
  if (['granted', 'denied', 'revoked', 'unknown'].includes(token)) return token;
  return normalizeToken(fallback, 40) || 'unknown';
}

function normalizeConsentMode(v, fallback = 'unknown') {
  const token = normalizeToken(v, 60);
  if ([
    'explicit_opt_in',
    'operator_policy',
    'contractual',
    'public_domain',
    'internal_system',
    'unknown'
  ].includes(token)) return token;
  return normalizeToken(fallback, 60) || 'unknown';
}

function defaultPolicy() {
  return {
    version: '1.0',
    schema: {
      id: 'protheus_training_conduit_datum',
      version: '1.0.0'
    },
    defaults: {
      owner_id: 'local_operator',
      owner_type: 'human_operator',
      license_id: 'internal_protheus',
      consent_status: 'granted',
      consent_mode: 'operator_policy',
      consent_evidence_ref: 'config/training_conduit_policy.json',
      retention_days: 365,
      delete_scope: 'training_conduit',
      classification: 'internal'
    },
    constraints: {
      min_retention_days: 1,
      max_retention_days: 3650,
      require_source: true,
      require_owner: true,
      require_license: true,
      require_consent: true,
      require_delete_key: true
    }
  };
}

function normalizePolicy(raw) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const schema = src.schema && typeof src.schema === 'object' ? src.schema : {};
  const defaults = src.defaults && typeof src.defaults === 'object' ? src.defaults : {};
  const constraints = src.constraints && typeof src.constraints === 'object' ? src.constraints : {};
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    schema: {
      id: cleanText(schema.id || base.schema.id, 120) || base.schema.id,
      version: cleanText(schema.version || base.schema.version, 40) || base.schema.version
    },
    defaults: {
      owner_id: normalizeToken(defaults.owner_id || base.defaults.owner_id, 120) || base.defaults.owner_id,
      owner_type: normalizeToken(defaults.owner_type || base.defaults.owner_type, 80) || base.defaults.owner_type,
      license_id: normalizeToken(defaults.license_id || base.defaults.license_id, 160) || base.defaults.license_id,
      consent_status: normalizeConsentStatus(defaults.consent_status, base.defaults.consent_status),
      consent_mode: normalizeConsentMode(defaults.consent_mode, base.defaults.consent_mode),
      consent_evidence_ref: relPath(defaults.consent_evidence_ref || base.defaults.consent_evidence_ref) || base.defaults.consent_evidence_ref,
      retention_days: clampInt(defaults.retention_days, 1, 3650, base.defaults.retention_days),
      delete_scope: normalizeToken(defaults.delete_scope || base.defaults.delete_scope, 120) || base.defaults.delete_scope,
      classification: normalizeToken(defaults.classification || base.defaults.classification, 80) || base.defaults.classification
    },
    constraints: {
      min_retention_days: clampInt(
        constraints.min_retention_days,
        1,
        3650,
        base.constraints.min_retention_days
      ),
      max_retention_days: clampInt(
        constraints.max_retention_days,
        1,
        3650 * 3,
        base.constraints.max_retention_days
      ),
      require_source: constraints.require_source !== false,
      require_owner: constraints.require_owner !== false,
      require_license: constraints.require_license !== false,
      require_consent: constraints.require_consent !== false,
      require_delete_key: constraints.require_delete_key !== false
    }
  };
}

function loadTrainingConduitPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJsonSafe(policyPath, defaultPolicy()));
}

function retentionExpiry(ts, days) {
  const base = Date.parse(String(ts || ''));
  if (!Number.isFinite(base)) return null;
  const ms = Number(days || 0) * 24 * 60 * 60 * 1000;
  return new Date(base + ms).toISOString();
}

function normalizeDeleteKey(v, fallback) {
  const token = normalizeToken(v, 220);
  if (token) return token;
  return normalizeToken(fallback, 220) || null;
}

function buildTrainingConduitMetadata(input = {}, policyInput = null) {
  const policy = normalizePolicy(policyInput || loadTrainingConduitPolicy());
  const ts = cleanText(input.ts || nowIso(), 64) || nowIso();
  const sourceSystem = normalizeToken(input.source_system || input.system || 'unknown', 120) || 'unknown';
  const sourceChannel = normalizeToken(input.source_channel || input.channel || 'unknown', 120) || 'unknown';
  const sourcePath = relPath(input.source_path || input.path || '') || null;
  const datumId = normalizeToken(input.datum_id || input.record_id || '', 180) || null;
  const provider = normalizeToken(input.provider || '', 120) || null;
  const ownerId = normalizeToken(input.owner_id || policy.defaults.owner_id, 120) || policy.defaults.owner_id;
  const ownerType = normalizeToken(input.owner_type || policy.defaults.owner_type, 80) || policy.defaults.owner_type;
  const licenseId = normalizeToken(input.license_id || policy.defaults.license_id, 160) || policy.defaults.license_id;
  const consentStatus = normalizeConsentStatus(input.consent_status || policy.defaults.consent_status, policy.defaults.consent_status);
  const consentMode = normalizeConsentMode(input.consent_mode || policy.defaults.consent_mode, policy.defaults.consent_mode);
  const consentEvidenceRef = relPath(input.consent_evidence_ref || policy.defaults.consent_evidence_ref) || policy.defaults.consent_evidence_ref;
  const retentionDays = clampInt(
    input.retention_days,
    Number(policy.constraints.min_retention_days || 1),
    Number(policy.constraints.max_retention_days || 3650),
    Number(policy.defaults.retention_days || 365)
  );
  const deleteScope = normalizeToken(input.delete_scope || policy.defaults.delete_scope, 120) || policy.defaults.delete_scope;
  const deleteKey = normalizeDeleteKey(input.delete_key, `${sourceSystem}:${sourceChannel}:${datumId || Date.parse(ts)}`);
  const classification = normalizeToken(input.classification || policy.defaults.classification, 80) || policy.defaults.classification;
  const metadata = {
    schema_id: String(policy.schema.id),
    schema_version: String(policy.schema.version),
    policy_version: String(policy.version),
    ts,
    source: {
      system: sourceSystem,
      channel: sourceChannel,
      path: sourcePath,
      datum_id: datumId,
      provider
    },
    owner: {
      id: ownerId,
      type: ownerType
    },
    license: {
      id: licenseId
    },
    consent: {
      status: consentStatus,
      mode: consentMode,
      evidence_ref: consentEvidenceRef || null
    },
    retention: {
      days: retentionDays,
      expires_ts: retentionExpiry(ts, retentionDays)
    },
    delete: {
      key: deleteKey,
      scope: deleteScope
    },
    classification
  };
  const validation = validateTrainingConduitMetadata(metadata, policy);
  metadata.validation = validation;
  return metadata;
}

function validateTrainingConduitMetadata(metadata, policyInput = null) {
  const policy = normalizePolicy(policyInput || loadTrainingConduitPolicy());
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  const errors = [];
  const source = m.source && typeof m.source === 'object' ? m.source : {};
  const owner = m.owner && typeof m.owner === 'object' ? m.owner : {};
  const license = m.license && typeof m.license === 'object' ? m.license : {};
  const consent = m.consent && typeof m.consent === 'object' ? m.consent : {};
  const retention = m.retention && typeof m.retention === 'object' ? m.retention : {};
  const deletion = m.delete && typeof m.delete === 'object' ? m.delete : {};

  if (policy.constraints.require_source) {
    if (!normalizeToken(source.system || '', 120)) errors.push('missing_source_system');
    if (!normalizeToken(source.channel || '', 120)) errors.push('missing_source_channel');
  }
  if (policy.constraints.require_owner && !normalizeToken(owner.id || '', 120)) {
    errors.push('missing_owner_id');
  }
  if (policy.constraints.require_license && !normalizeToken(license.id || '', 160)) {
    errors.push('missing_license_id');
  }
  if (policy.constraints.require_consent) {
    if (!normalizeConsentStatus(consent.status, '')) errors.push('missing_consent_status');
    if (!normalizeConsentMode(consent.mode, '')) errors.push('missing_consent_mode');
  }
  const retentionDays = clampInt(
    retention.days,
    Number(policy.constraints.min_retention_days || 1),
    Number(policy.constraints.max_retention_days || 3650),
    -1
  );
  if (retentionDays < Number(policy.constraints.min_retention_days || 1)
    || retentionDays > Number(policy.constraints.max_retention_days || 3650)) {
    errors.push('retention_days_out_of_range');
  }
  if (policy.constraints.require_delete_key && !normalizeToken(deletion.key || '', 220)) {
    errors.push('missing_delete_key');
  }
  return {
    ok: errors.length === 0,
    errors,
    policy_version: String(policy.version)
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  defaultPolicy,
  normalizePolicy,
  loadTrainingConduitPolicy,
  buildTrainingConduitMetadata,
  validateTrainingConduitMetadata
};

export {};

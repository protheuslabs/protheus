#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function hmacHex(payload: unknown, key: string) {
  return crypto.createHmac('sha256', String(key || '')).update(stableStringify(payload), 'utf8').digest('hex');
}

function fileSha256OrNull(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null;
    if (!fs.statSync(filePath).isFile()) return null;
    return sha256Hex(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveHelixKey(policy: AnyObj = {}) {
  const envName = cleanText(
    policy && policy.codex && policy.codex.key_env,
    80
  ) || 'HELIX_CODEX_KEY';
  const key = cleanText(process.env[envName] || '', 8192);
  return {
    env_name: envName,
    key
  };
}

function codexMetaFromPolicy(policy: AnyObj = {}) {
  const codex = policy && policy.codex && typeof policy.codex === 'object'
    ? policy.codex
    : {};
  const bootstrapTruths = Array.isArray(codex.bootstrap_truths)
    ? codex.bootstrap_truths
        .map((row: unknown) => cleanText(row, 200))
        .filter(Boolean)
        .slice(0, 64)
    : [];
  const constitutionPathRaw = cleanText(codex.constitution_path || 'AGENT-CONSTITUTION.md', 300) || 'AGENT-CONSTITUTION.md';
  const constitutionPath = path.isAbsolute(constitutionPathRaw)
    ? constitutionPathRaw
    : path.join(ROOT, constitutionPathRaw);
  const soulStateRaw = cleanText(codex.soul_token_state_path || 'state/security/soul_token_guard.json', 300)
    || 'state/security/soul_token_guard.json';
  const soulStatePath = path.isAbsolute(soulStateRaw)
    ? soulStateRaw
    : path.join(ROOT, soulStateRaw);
  const soulBiometricRaw = cleanText(
    codex.soul_biometric_state_path || 'state/security/soul_biometric/latest.json',
    300
  ) || 'state/security/soul_biometric/latest.json';
  const soulBiometricPath = path.isAbsolute(soulBiometricRaw)
    ? soulBiometricRaw
    : path.join(ROOT, soulBiometricRaw);
  return {
    codex_id: normalizeToken(codex.codex_id || 'protheus_helix_codex', 80) || 'protheus_helix_codex',
    bootstrap_truths: bootstrapTruths.length
      ? bootstrapTruths
      : [
          'preserve_constitutional_root',
          'preserve_user_sovereignty',
          'deny_unauthorized_self_rewrite',
          'fail_secure_before_actuation'
        ],
    constitution_path: constitutionPath,
    soul_state_path: soulStatePath,
    soul_biometric_state_path: soulBiometricPath
  };
}

function normalizeCodex(raw: AnyObj = {}) {
  return {
    schema_id: 'helix_codex_root',
    schema_version: '1.0',
    codex_id: normalizeToken(raw.codex_id || 'protheus_helix_codex', 80) || 'protheus_helix_codex',
    created_at: String(raw.created_at || ''),
    updated_at: String(raw.updated_at || ''),
    root_hash: cleanText(raw.root_hash, 128),
    signature: cleanText(raw.signature, 200),
    body: raw.body && typeof raw.body === 'object'
      ? raw.body
      : {}
  };
}

function buildCodexRoot(policy: AnyObj = {}, opts: AnyObj = {}) {
  const meta = codexMetaFromPolicy(policy);
  const soulState = readJson(meta.soul_state_path, {});
  const soulBiometric = readJson(meta.soul_biometric_state_path, {});
  const soulFingerprint = cleanText(soulState && soulState.fingerprint || '', 320) || null;
  const soulInstanceId = normalizeToken(soulState && soulState.instance_id || '', 120) || null;
  const soulCommitmentId = cleanText(soulBiometric && soulBiometric.commitment_id || '', 120) || null;
  const soulTemplateId = cleanText(soulBiometric && soulBiometric.template_id || '', 120) || null;
  const soulBiometricConfidence = Number(
    soulBiometric && soulBiometric.confidence != null ? soulBiometric.confidence : 0
  );
  const constitutionHash = fileSha256OrNull(meta.constitution_path);
  const keyInfo = resolveHelixKey(policy);
  const nowTs = nowIso();
  const body = {
    codex_id: meta.codex_id,
    bootstrap_truths: meta.bootstrap_truths,
    constitution: {
      path: path.relative(ROOT, meta.constitution_path).replace(/\\/g, '/'),
      sha256: constitutionHash
    },
    soul_binding: {
      fingerprint: soulFingerprint,
      instance_id: soulInstanceId,
      biometric_commitment_id: soulCommitmentId,
      biometric_template_id: soulTemplateId,
      biometric_confidence: Number.isFinite(soulBiometricConfidence)
        ? Number(soulBiometricConfidence.toFixed(6))
        : 0
    },
    approval_note: cleanText(opts.approval_note || '', 220) || null
  };
  const rootHash = sha256Hex(stableStringify(body));
  const signature = keyInfo.key
    ? hmacHex({
        codex_id: meta.codex_id,
        root_hash: rootHash,
        body
      }, keyInfo.key)
    : '';
  return normalizeCodex({
    codex_id: meta.codex_id,
    created_at: nowTs,
    updated_at: nowTs,
    root_hash: rootHash,
    signature,
    body
  });
}

function verifyCodexRoot(codex: AnyObj, policy: AnyObj = {}) {
  const normalized = normalizeCodex(codex);
  const body = normalized.body && typeof normalized.body === 'object'
    ? normalized.body
    : {};
  const computedRootHash = sha256Hex(stableStringify(body));
  const keyInfo = resolveHelixKey(policy);
  const expectedSignature = keyInfo.key
    ? hmacHex({
        codex_id: normalized.codex_id,
        root_hash: computedRootHash,
        body
      }, keyInfo.key)
    : '';
  const reasonCodes: string[] = [];
  if (!normalized.root_hash) reasonCodes.push('codex_root_hash_missing');
  if (normalized.root_hash && normalized.root_hash !== computedRootHash) reasonCodes.push('codex_root_hash_mismatch');
  if (!keyInfo.key) reasonCodes.push('codex_signing_key_missing');
  if (keyInfo.key && !normalized.signature) reasonCodes.push('codex_signature_missing');
  if (keyInfo.key && normalized.signature && normalized.signature !== expectedSignature) {
    reasonCodes.push('codex_signature_mismatch');
  }
  return {
    ok: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    key_env: keyInfo.env_name,
    key_present: !!keyInfo.key,
    computed_root_hash: computedRootHash,
    codex_root_hash: normalized.root_hash,
    codex_signature: normalized.signature
  };
}

function loadCodex(codexPath: string) {
  return normalizeCodex(readJson(codexPath, {}));
}

function initCodex(codexPath: string, policy: AnyObj = {}, opts: AnyObj = {}) {
  const current = loadCodex(codexPath);
  if (current && current.root_hash && opts.overwrite !== true) {
    const verified = verifyCodexRoot(current, policy);
    return {
      ok: verified.ok,
      type: 'helix_codex_init',
      created: false,
      codex_path: codexPath,
      codex: current,
      verification: verified
    };
  }
  const codex = buildCodexRoot(policy, opts);
  writeJsonAtomic(codexPath, codex);
  const verification = verifyCodexRoot(codex, policy);
  return {
    ok: verification.ok,
    type: 'helix_codex_init',
    created: true,
    codex_path: codexPath,
    codex,
    verification
  };
}

module.exports = {
  buildCodexRoot,
  verifyCodexRoot,
  loadCodex,
  initCodex
};

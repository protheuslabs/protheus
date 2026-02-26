#!/usr/bin/env node
'use strict';
export {};

/**
 * soul_token_guard.js
 *
 * Watermark + soul-token anti-cloning guard (V2-058).
 *
 * Usage:
 *   node systems/security/soul_token_guard.js issue [--instance-id=<id>] [--approval-note="<text>"]
 *   node systems/security/soul_token_guard.js stamp-build --build-id=<id> [--channel=<name>] [--valid-hours=168]
 *   node systems/security/soul_token_guard.js verify [--strict=1]
 *   node systems/security/soul_token_guard.js status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SOUL_TOKEN_GUARD_POLICY_PATH
  ? path.resolve(process.env.SOUL_TOKEN_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'soul_token_guard_policy.json');
const DEFAULT_SOUL_POLICY_PATH = path.join(ROOT, 'config', 'soul_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 400);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hmacHex(value: unknown, secret: string) {
  return crypto.createHmac('sha256', String(secret || '')).update(stableStringify(value)).digest('hex');
}

function sha16(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function currentFingerprint() {
  const forced = clean(process.env.SOUL_TOKEN_GUARD_FINGERPRINT || '', 320);
  if (forced) return forced;
  const parts = [
    os.hostname(),
    process.platform,
    process.arch,
    ROOT
  ];
  return `fp_${sha16(parts.join('|'))}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    enforcement_mode: 'advisory', // advisory|enforced
    bind_to_fingerprint: true,
    default_attestation_valid_hours: 24 * 7,
    key_env: 'SOUL_TOKEN_GUARD_KEY',
    token_state_path: 'state/security/soul_token_guard.json',
    audit_path: 'state/security/soul_token_guard_audit.jsonl',
    attestation_path: 'state/security/release_attestations.jsonl',
    black_box_attestation_dir: 'state/security/black_box_ledger/attestations',
    biometric_attestation: {
      enabled: true,
      shadow_only: true,
      require_for_verify: false,
      min_confidence: 0.82,
      min_live_modalities: 2,
      timeout_ms: 8000,
      script: 'systems/soul/soul_print_manager.js',
      policy_path: 'config/soul_policy.json'
    }
  };
}

function normalizeMode(raw: unknown) {
  const s = clean(raw, 24).toLowerCase();
  return s === 'enforced' ? 'enforced' : 'advisory';
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const biometric = raw.biometric_attestation && typeof raw.biometric_attestation === 'object'
    ? raw.biometric_attestation
    : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    enforcement_mode: normalizeMode(raw.enforcement_mode || base.enforcement_mode),
    bind_to_fingerprint: toBool(raw.bind_to_fingerprint, true),
    default_attestation_valid_hours: clampInt(
      raw.default_attestation_valid_hours,
      1,
      24 * 365,
      base.default_attestation_valid_hours
    ),
    key_env: clean(raw.key_env || base.key_env, 80) || base.key_env,
    token_state_path: resolvePath(raw.token_state_path, base.token_state_path),
    audit_path: resolvePath(raw.audit_path, base.audit_path),
    attestation_path: resolvePath(raw.attestation_path, base.attestation_path),
    black_box_attestation_dir: resolvePath(raw.black_box_attestation_dir, base.black_box_attestation_dir),
    biometric_attestation: {
      enabled: toBool(biometric.enabled, base.biometric_attestation.enabled),
      shadow_only: toBool(biometric.shadow_only, base.biometric_attestation.shadow_only),
      require_for_verify: toBool(
        biometric.require_for_verify,
        base.biometric_attestation.require_for_verify
      ),
      min_confidence: Number(
        Math.max(0, Math.min(1, Number(
          biometric.min_confidence == null
            ? base.biometric_attestation.min_confidence
            : biometric.min_confidence
        )))
      ),
      min_live_modalities: clampInt(
        biometric.min_live_modalities,
        1,
        32,
        base.biometric_attestation.min_live_modalities
      ),
      timeout_ms: clampInt(
        biometric.timeout_ms,
        200,
        120000,
        base.biometric_attestation.timeout_ms
      ),
      script: resolvePath(
        biometric.script,
        base.biometric_attestation.script
      ),
      policy_path: resolvePath(
        biometric.policy_path,
        base.biometric_attestation.policy_path
      )
    }
  };
}

function resolveKey(policy: AnyObj) {
  const envName = clean(policy && policy.key_env || '', 80) || 'SOUL_TOKEN_GUARD_KEY';
  const key = clean(process.env[envName] || '', 4096);
  return {
    env_name: envName,
    key
  };
}

function appendBlackBoxAttestation(policy: AnyObj, row: AnyObj) {
  const date = nowIso().slice(0, 10);
  const filePath = path.join(policy.black_box_attestation_dir, `${date}.jsonl`);
  appendJsonl(filePath, {
    ts: nowIso(),
    type: 'cross_runtime_attestation',
    system: 'soul_token_guard',
    ...row
  });
}

function loadTokenState(policy: AnyObj) {
  return readJson(policy.token_state_path, null);
}

function latestAttestation(policy: AnyObj) {
  const rows = readJsonl(policy.attestation_path);
  const filtered = rows
    .filter((row: AnyObj) => String(row && row.type || '') === 'soul_release_attestation')
    .sort((a: AnyObj, b: AnyObj) => {
      const ta = Date.parse(String(a && a.issued_at || ''));
      const tb = Date.parse(String(b && b.issued_at || ''));
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  return filtered.length ? filtered[0] : null;
}

function evaluateBiometricAttestation(policy: AnyObj) {
  const cfg = policy && policy.biometric_attestation && typeof policy.biometric_attestation === 'object'
    ? policy.biometric_attestation
    : {};
  const enabled = cfg.enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      checked: false,
      match: null,
      confidence: null,
      liveness_ok: null,
      shadow_only: false,
      require_for_verify: false,
      min_confidence: null,
      min_live_modalities: null,
      reason: 'biometric_disabled'
    };
  }
  const scriptPath = resolvePath(cfg.script, path.join(ROOT, 'systems', 'soul', 'soul_print_manager.js'));
  const policyPath = resolvePath(cfg.policy_path, DEFAULT_SOUL_POLICY_PATH);
  const timeoutMs = clampInt(cfg.timeout_ms, 200, 120000, 8000);
  const minConfidence = Number(
    Math.max(0, Math.min(1, Number(cfg.min_confidence == null ? 0.82 : cfg.min_confidence)))
  );
  const minLiveModalities = clampInt(cfg.min_live_modalities, 1, 32, 2);
  const requireForVerify = cfg.require_for_verify === true;
  if (!fs.existsSync(scriptPath)) {
    return {
      enabled: true,
      checked: false,
      match: false,
      confidence: 0,
      liveness_ok: false,
      shadow_only: true,
      require_for_verify: requireForVerify,
      min_confidence: minConfidence,
      min_live_modalities: minLiveModalities,
      reason: 'biometric_script_missing',
      script_path: scriptPath,
      policy_path: policyPath
    };
  }
  const result = spawnSync(process.execPath, [
    scriptPath,
    'run',
    `--policy=${policyPath}`,
    '--shadow-only=1'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJsonPayload(result && result.stdout);
  const checked = Number(result && result.status) === 0
    && payload
    && payload.ok === true;
  const match = !!(checked && payload && payload.match === true);
  const confidence = Number(payload && payload.confidence != null ? payload.confidence : 0);
  const livenessOk = payload && payload.liveness_ok === true;
  const reason = clean(
    (payload && payload.error)
      || (payload && Array.isArray(payload.reason_codes) && payload.reason_codes[0])
      || (checked ? (match ? 'biometric_verified' : 'biometric_not_matched') : '')
      || (result && result.stderr)
      || (result && result.stdout)
      || 'biometric_attestation_unknown',
    160
  ) || 'biometric_attestation_unknown';
  return {
    enabled: true,
    checked,
    match,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    liveness_ok: livenessOk === true,
    shadow_only: cfg.shadow_only !== false,
    require_for_verify: requireForVerify,
    min_confidence: minConfidence,
    min_live_modalities: minLiveModalities,
    reason,
    script_path: scriptPath,
    policy_path: policyPath,
    payload: payload && typeof payload === 'object'
      ? {
          type: payload.type || null,
          matched_modalities: Number(payload.matched_modalities || 0),
          total_modalities: Number(payload.total_modalities || 0),
          commitment_id: payload.commitment_id || null,
          template_id: payload.template_id || null
        }
      : null
  };
}

function evaluateEnforcement(policy: AnyObj) {
  const token = loadTokenState(policy);
  const keyInfo = resolveKey(policy);
  const fingerprint = currentFingerprint();
  const attestation = latestAttestation(policy);
  const biometric = evaluateBiometricAttestation(policy);
  const biometricMismatch = (
    biometric && biometric.enabled === true
    && (
      biometric.checked !== true
      || biometric.match !== true
      || biometric.liveness_ok !== true
      || Number(biometric.confidence || 0) < Number(biometric.min_confidence || 0)
    )
  );
  const biometricForcedShadow = biometric && biometric.require_for_verify === true && biometricMismatch;
  const finalize = (base: AnyObj = {}) => {
    const next = {
      ...base,
      biometric_attestation: biometric
    };
    if (next.shadow_only === false && biometricForcedShadow) {
      next.shadow_only = true;
      next.reason = `biometric_${clean(biometric && biometric.reason || 'mismatch', 80) || 'mismatch'}`;
      next.biometric_forced_shadow = true;
    } else {
      next.biometric_forced_shadow = false;
    }
    return next;
  };

  if (policy.enabled !== true) {
    return finalize({
      shadow_only: false,
      reason: 'disabled',
      token_present: !!token,
      attestation_present: !!attestation,
      fingerprint
    });
  }

  if (!token || typeof token !== 'object') {
    return finalize({
      shadow_only: policy.enforcement_mode === 'enforced',
      reason: 'token_missing',
      token_present: false,
      attestation_present: !!attestation,
      fingerprint
    });
  }

  if (policy.bind_to_fingerprint === true && clean(token.fingerprint || '', 320) !== fingerprint) {
    return finalize({
      shadow_only: true,
      reason: 'token_fingerprint_mismatch',
      token_present: true,
      attestation_present: !!attestation,
      fingerprint
    });
  }

  if (!attestation || typeof attestation !== 'object') {
    return finalize({
      shadow_only: policy.enforcement_mode === 'enforced',
      reason: 'attestation_missing',
      token_present: true,
      attestation_present: false,
      fingerprint
    });
  }

  const sig = clean(attestation.signature || '', 200);
  const signedPayload = { ...attestation };
  delete signedPayload.signature;
  const expectedSig = keyInfo.key ? hmacHex(signedPayload, keyInfo.key) : '';
  if (!sig || !expectedSig || sig !== expectedSig) {
    return finalize({
      shadow_only: true,
      reason: 'attestation_signature_invalid',
      token_present: true,
      attestation_present: true,
      fingerprint
    });
  }

  const exp = Date.parse(String(attestation.expires_at || ''));
  if (!Number.isFinite(exp) || exp < Date.now()) {
    return finalize({
      shadow_only: true,
      reason: 'attestation_expired',
      token_present: true,
      attestation_present: true,
      fingerprint
    });
  }

  if (clean(attestation.watermark_id || '', 80) !== clean(token.watermark_id || '', 80)) {
    return finalize({
      shadow_only: true,
      reason: 'watermark_mismatch',
      token_present: true,
      attestation_present: true,
      fingerprint
    });
  }

  if (policy.bind_to_fingerprint === true && clean(attestation.fingerprint || '', 320) !== fingerprint) {
    return finalize({
      shadow_only: true,
      reason: 'attestation_fingerprint_mismatch',
      token_present: true,
      attestation_present: true,
      fingerprint
    });
  }

  return finalize({
    shadow_only: false,
    reason: 'verified',
    token_present: true,
    attestation_present: true,
    fingerprint
  });
}

function requireApprovalNote(args: AnyObj) {
  const note = clean(args['approval-note'] || args.approval_note || '', 320);
  if (note.length >= 8) return note;
  return null;
}

function cmdIssue(policy: AnyObj, args: AnyObj) {
  const note = requireApprovalNote(args);
  if (!note) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'approval_note_required', min_len: 8 })}\n`);
    process.exit(2);
  }
  const instanceId = clean(args['instance-id'] || args.instance_id || `inst_${sha16(nowIso())}`, 80);
  const fingerprint = currentFingerprint();
  const soulToken = `soul_${crypto.randomBytes(16).toString('hex')}`;
  const watermarkId = `wm_${sha16(`${instanceId}|${fingerprint}|${soulToken}`)}`;
  const tokenState = {
    type: 'soul_token',
    version: policy.version,
    issued_at: nowIso(),
    instance_id: instanceId,
    fingerprint,
    watermark_id: watermarkId,
    soul_token: soulToken,
    enforcement: {
      shadow_only: false,
      reason: 'issued'
    }
  };
  writeJsonAtomic(policy.token_state_path, tokenState);
  const receipt = {
    ts: nowIso(),
    type: 'soul_token_issue',
    instance_id: instanceId,
    fingerprint,
    watermark_id: watermarkId,
    approval_note: note
  };
  appendJsonl(policy.audit_path, receipt);
  appendBlackBoxAttestation(policy, {
    boundary: 'soul_token_issue',
    chain_hash: sha16(stableStringify(receipt)),
    signer: 'local_root',
    ok: true
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'soul_token_issue',
    ts: nowIso(),
    instance_id: instanceId,
    fingerprint,
    watermark_id: watermarkId,
    token_state_path: relPath(policy.token_state_path)
  })}\n`);
}

function cmdStampBuild(policy: AnyObj, args: AnyObj) {
  const buildId = clean(args['build-id'] || args.build_id || '', 120);
  if (!buildId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'build_id_required' })}\n`);
    process.exit(2);
  }
  const token = loadTokenState(policy);
  if (!token || typeof token !== 'object') {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'token_missing' })}\n`);
    process.exit(1);
  }
  const keyInfo = resolveKey(policy);
  if (!keyInfo.key) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'signing_key_missing', key_env: keyInfo.env_name })}\n`);
    process.exit(1);
  }
  const channel = clean(args.channel || 'local', 48) || 'local';
  const validHours = clampInt(
    args['valid-hours'] || args.valid_hours,
    1,
    24 * 365,
    policy.default_attestation_valid_hours
  );
  const issuedAt = nowIso();
  const attestationPayload = {
    type: 'soul_release_attestation',
    schema_version: '1.0.0',
    attestation_id: `att_${sha16(`${buildId}|${issuedAt}`)}`,
    build_id: buildId,
    channel,
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + validHours * 60 * 60 * 1000).toISOString(),
    instance_id: clean(token.instance_id || '', 80) || null,
    fingerprint: currentFingerprint(),
    watermark_id: clean(token.watermark_id || '', 80) || null,
    code_signature: sha16(`${buildId}|${clean(token.watermark_id || '', 80)}|${currentFingerprint()}`)
  };
  const signed = {
    ...attestationPayload,
    signature: hmacHex(attestationPayload, keyInfo.key)
  };
  appendJsonl(policy.attestation_path, signed);
  appendJsonl(policy.audit_path, {
    ts: nowIso(),
    type: 'soul_release_attestation_issued',
    attestation_id: signed.attestation_id,
    build_id: signed.build_id,
    channel: signed.channel
  });
  appendBlackBoxAttestation(policy, {
    boundary: 'soul_release_attestation',
    chain_hash: sha16(stableStringify(signed)),
    signature: signed.signature,
    signer: 'local_root',
    ok: true
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'soul_release_attestation_issued',
    ts: nowIso(),
    attestation_id: signed.attestation_id,
    build_id: signed.build_id,
    attestation_path: relPath(policy.attestation_path)
  })}\n`);
}

function cmdVerify(policy: AnyObj, strict: boolean) {
  const evalResult = evaluateEnforcement(policy);
  const token = loadTokenState(policy);
  if (token && typeof token === 'object') {
    token.last_verified_at = nowIso();
    token.enforcement = {
      shadow_only: evalResult.shadow_only === true,
      reason: evalResult.reason || null
    };
    writeJsonAtomic(policy.token_state_path, token);
  }
  const receipt = {
    ts: nowIso(),
    type: 'soul_token_verify',
    enforcement_mode: policy.enforcement_mode,
    shadow_only: evalResult.shadow_only === true,
    reason: evalResult.reason || null,
    fingerprint: evalResult.fingerprint || null
  };
  appendJsonl(policy.audit_path, receipt);
  appendBlackBoxAttestation(policy, {
    boundary: 'soul_token_verify',
    chain_hash: sha16(stableStringify(receipt)),
    signer: 'local_root',
    ok: evalResult.shadow_only !== true
  });

  const payload = {
    ok: evalResult.shadow_only !== true || strict !== true,
    type: 'soul_token_verify',
    ts: nowIso(),
    enforcement_mode: policy.enforcement_mode,
    shadow_only: evalResult.shadow_only === true,
    reason: evalResult.reason || null,
    token_present: evalResult.token_present === true,
    attestation_present: evalResult.attestation_present === true,
    fingerprint: evalResult.fingerprint || null,
    biometric_attestation: evalResult.biometric_attestation && typeof evalResult.biometric_attestation === 'object'
      ? {
          enabled: evalResult.biometric_attestation.enabled === true,
          checked: evalResult.biometric_attestation.checked === true,
          match: evalResult.biometric_attestation.match === true,
          confidence: Number(evalResult.biometric_attestation.confidence || 0),
          min_confidence: Number(evalResult.biometric_attestation.min_confidence || 0),
          liveness_ok: evalResult.biometric_attestation.liveness_ok === true,
          require_for_verify: evalResult.biometric_attestation.require_for_verify === true,
          shadow_only: evalResult.biometric_attestation.shadow_only === true,
          reason: evalResult.biometric_attestation.reason || null,
          payload: evalResult.biometric_attestation.payload || null
        }
      : null,
    biometric_forced_shadow: evalResult.biometric_forced_shadow === true,
    token_state_path: relPath(policy.token_state_path),
    attestation_path: relPath(policy.attestation_path),
    audit_path: relPath(policy.audit_path)
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict === true && evalResult.shadow_only === true) process.exit(1);
}

function cmdStatus(policy: AnyObj) {
  const token = loadTokenState(policy);
  const evalResult = evaluateEnforcement(policy);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'soul_token_status',
    ts: nowIso(),
    policy_version: policy.version,
    enforcement_mode: policy.enforcement_mode,
    token_present: !!token,
    instance_id: token && token.instance_id ? token.instance_id : null,
    watermark_id: token && token.watermark_id ? token.watermark_id : null,
    fingerprint: evalResult.fingerprint || null,
    enforcement: {
      shadow_only: evalResult.shadow_only === true,
      reason: evalResult.reason || null
    },
    biometric_attestation: evalResult.biometric_attestation && typeof evalResult.biometric_attestation === 'object'
      ? {
          enabled: evalResult.biometric_attestation.enabled === true,
          checked: evalResult.biometric_attestation.checked === true,
          match: evalResult.biometric_attestation.match === true,
          confidence: Number(evalResult.biometric_attestation.confidence || 0),
          min_confidence: Number(evalResult.biometric_attestation.min_confidence || 0),
          liveness_ok: evalResult.biometric_attestation.liveness_ok === true,
          require_for_verify: evalResult.biometric_attestation.require_for_verify === true,
          shadow_only: evalResult.biometric_attestation.shadow_only === true,
          reason: evalResult.biometric_attestation.reason || null,
          payload: evalResult.biometric_attestation.payload || null
        }
      : null,
    biometric_forced_shadow: evalResult.biometric_forced_shadow === true,
    token_state_path: relPath(policy.token_state_path),
    attestation_path: relPath(policy.attestation_path),
    audit_path: relPath(policy.audit_path)
  })}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/soul_token_guard.js issue [--instance-id=<id>] --approval-note="<text>"');
  console.log('  node systems/security/soul_token_guard.js stamp-build --build-id=<id> [--channel=<name>] [--valid-hours=168]');
  console.log('  node systems/security/soul_token_guard.js verify [--strict=1]');
  console.log('  node systems/security/soul_token_guard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'status', 24).toLowerCase();
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (cmd === 'issue') return cmdIssue(policy, args);
  if (cmd === 'stamp-build') return cmdStampBuild(policy, args);
  if (cmd === 'verify') return cmdVerify(policy, toBool(args.strict, false));
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'soul_token_guard',
      error: clean(err && err.message ? err.message : err || 'soul_token_guard_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

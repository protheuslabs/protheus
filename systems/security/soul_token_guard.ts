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

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SOUL_TOKEN_GUARD_POLICY_PATH
  ? path.resolve(process.env.SOUL_TOKEN_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'soul_token_guard_policy.json');

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
    black_box_attestation_dir: 'state/security/black_box_ledger/attestations'
  };
}

function normalizeMode(raw: unknown) {
  const s = clean(raw, 24).toLowerCase();
  return s === 'enforced' ? 'enforced' : 'advisory';
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
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
    black_box_attestation_dir: resolvePath(raw.black_box_attestation_dir, base.black_box_attestation_dir)
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

function evaluateEnforcement(policy: AnyObj) {
  const token = loadTokenState(policy);
  const keyInfo = resolveKey(policy);
  const fingerprint = currentFingerprint();
  const attestation = latestAttestation(policy);

  if (policy.enabled !== true) {
    return {
      shadow_only: false,
      reason: 'disabled',
      token_present: !!token,
      attestation_present: !!attestation,
      fingerprint
    };
  }

  if (!token || typeof token !== 'object') {
    return {
      shadow_only: policy.enforcement_mode === 'enforced',
      reason: 'token_missing',
      token_present: false,
      attestation_present: !!attestation,
      fingerprint
    };
  }

  if (policy.bind_to_fingerprint === true && clean(token.fingerprint || '', 320) !== fingerprint) {
    return {
      shadow_only: true,
      reason: 'token_fingerprint_mismatch',
      token_present: true,
      attestation_present: !!attestation,
      fingerprint
    };
  }

  if (!attestation || typeof attestation !== 'object') {
    return {
      shadow_only: policy.enforcement_mode === 'enforced',
      reason: 'attestation_missing',
      token_present: true,
      attestation_present: false,
      fingerprint
    };
  }

  const sig = clean(attestation.signature || '', 200);
  const signedPayload = { ...attestation };
  delete signedPayload.signature;
  const expectedSig = keyInfo.key ? hmacHex(signedPayload, keyInfo.key) : '';
  if (!sig || !expectedSig || sig !== expectedSig) {
    return {
      shadow_only: true,
      reason: 'attestation_signature_invalid',
      token_present: true,
      attestation_present: true,
      fingerprint
    };
  }

  const exp = Date.parse(String(attestation.expires_at || ''));
  if (!Number.isFinite(exp) || exp < Date.now()) {
    return {
      shadow_only: true,
      reason: 'attestation_expired',
      token_present: true,
      attestation_present: true,
      fingerprint
    };
  }

  if (clean(attestation.watermark_id || '', 80) !== clean(token.watermark_id || '', 80)) {
    return {
      shadow_only: true,
      reason: 'watermark_mismatch',
      token_present: true,
      attestation_present: true,
      fingerprint
    };
  }

  if (policy.bind_to_fingerprint === true && clean(attestation.fingerprint || '', 320) !== fingerprint) {
    return {
      shadow_only: true,
      reason: 'attestation_fingerprint_mismatch',
      token_present: true,
      attestation_present: true,
      fingerprint
    };
  }

  return {
    shadow_only: false,
    reason: 'verified',
    token_present: true,
    attestation_present: true,
    fingerprint
  };
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


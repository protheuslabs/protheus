#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-102
 * Offline statistical lab artifact bridge.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.OFFLINE_LAB_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.OFFLINE_LAB_BRIDGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'offline_statistical_lab_artifact_bridge_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function hashText(v: unknown, len = 24) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function canonical(value: unknown) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => canonical(row)).join(',')}]`;
  const keys = Object.keys(value as Record<string, any>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, any>)[k])}`).join(',')}}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_fields: ['artifact_id', 'producer', 'job_type', 'payload', 'signature', 'signing_key_id'],
    trusted_signing_keys: {
      lab_key_1: 'lab_shared_secret_v1'
    },
    paths: {
      incoming_dir: 'state/sensory/offline_lab/artifacts',
      output_dir: 'state/sensory/analysis/offline_lab_bridge',
      latest_path: 'state/sensory/analysis/offline_lab_bridge/latest.json',
      receipts_path: 'state/sensory/analysis/offline_lab_bridge/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    required_fields: Array.isArray(raw.required_fields) ? raw.required_fields.map((x: any) => cleanText(x, 80)).filter(Boolean) : base.required_fields,
    trusted_signing_keys: raw.trusted_signing_keys && typeof raw.trusted_signing_keys === 'object'
      ? raw.trusted_signing_keys
      : base.trusted_signing_keys,
    paths: {
      incoming_dir: resolvePath(paths.incoming_dir, base.paths.incoming_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function verifyArtifact(artifact: Record<string, any>, policy: Record<string, any>) {
  const missing = [];
  for (const field of policy.required_fields || []) {
    if (!(field in artifact)) missing.push(field);
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_required_fields', missing };
  }

  const keyId = cleanText(artifact.signing_key_id || '', 80);
  const keySecret = keyId ? policy.trusted_signing_keys[keyId] : null;
  if (!keySecret) {
    return { ok: false, reason: 'unknown_signing_key', key_id: keyId || null };
  }

  const payloadCanonical = canonical(artifact.payload);
  const payloadHash = hashText(payloadCanonical, 64);
  const expectedSig = hashText(`${keySecret}|${payloadHash}`, 64);
  const providedSig = cleanText(artifact.signature || '', 80);

  if (expectedSig !== providedSig) {
    return { ok: false, reason: 'signature_mismatch', key_id: keyId, payload_hash: payloadHash };
  }

  return {
    ok: true,
    key_id: keyId,
    payload_hash: payloadHash,
    signature: providedSig
  };
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const inputPath = path.join(policy.paths.incoming_dir, `${dateStr}.json`);
  const artifact = readJson(inputPath, null) || {};
  const verification = verifyArtifact(artifact, policy);

  const out = {
    ok: verification.ok === true,
    type: 'offline_statistical_lab_artifact_bridge',
    ts: nowIso(),
    date: dateStr,
    input_path: inputPath,
    artifact_id: cleanText(artifact.artifact_id || '', 120) || null,
    producer: cleanText(artifact.producer || '', 120) || null,
    job_type: cleanText(artifact.job_type || '', 120) || null,
    verification,
    payload: verification.ok ? artifact.payload : null,
    provenance: verification.ok ? {
      signing_key_id: verification.key_id,
      payload_hash: verification.payload_hash,
      signature: verification.signature
    } : null
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'offline_lab_bridge_receipt',
    date: dateStr,
    artifact_id: out.artifact_id,
    ok: out.ok,
    verification
  });

  if (strict && !out.ok) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>) {
  const payload = readJson(policy.paths.latest_path, {
    ok: true,
    type: 'offline_statistical_lab_artifact_bridge_status',
    artifact_id: null
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/offline_statistical_lab_artifact_bridge.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/offline_statistical_lab_artifact_bridge.js status [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy);
  return usageAndExit(2);
}

module.exports = {
  run,
  verifyArtifact
};

if (require.main === module) {
  main();
}

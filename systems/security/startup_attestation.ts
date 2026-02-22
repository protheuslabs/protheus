#!/usr/bin/env node
'use strict';

/**
 * startup_attestation.js
 *
 * Signed startup attestation over critical policy/config hashes.
 *
 * Usage:
 *   node systems/security/startup_attestation.js issue [--ttl-hours=N] [--strict]
 *   node systems/security/startup_attestation.js verify [--strict]
 *   node systems/security/startup_attestation.js status
 *   node systems/security/startup_attestation.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.STARTUP_ATTESTATION_ROOT
  ? path.resolve(process.env.STARTUP_ATTESTATION_ROOT)
  : path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.STARTUP_ATTESTATION_POLICY_PATH
  ? path.resolve(process.env.STARTUP_ATTESTATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'startup_attestation_policy.json');
const STATE_PATH = process.env.STARTUP_ATTESTATION_STATE_PATH
  ? path.resolve(process.env.STARTUP_ATTESTATION_STATE_PATH)
  : path.join(ROOT, 'state', 'security', 'startup_attestation.json');
const AUDIT_PATH = process.env.STARTUP_ATTESTATION_AUDIT_PATH
  ? path.resolve(process.env.STARTUP_ATTESTATION_AUDIT_PATH)
  : path.join(ROOT, 'state', 'security', 'startup_attestation_audit.jsonl');
const DEFAULT_SECRETS_DIR = process.env.SECRET_BROKER_SECRETS_DIR
  ? path.resolve(process.env.SECRET_BROKER_SECRETS_DIR)
  : path.join(os.homedir(), '.config', 'protheus', 'secrets');
const SECRET_FILE_CANDIDATES = [
  process.env.STARTUP_ATTESTATION_KEY_PATH ? path.resolve(process.env.STARTUP_ATTESTATION_KEY_PATH) : '',
  process.env.SECRET_BROKER_LOCAL_KEY_PATH ? path.resolve(process.env.SECRET_BROKER_LOCAL_KEY_PATH) : '',
  path.join(DEFAULT_SECRETS_DIR, 'startup_attestation_key.txt'),
  path.join(DEFAULT_SECRETS_DIR, 'secret_broker_key.txt'),
  path.join(ROOT, 'state', 'security', 'secret_broker_key.txt')
].filter(Boolean);

/**
 * @typedef {{
 *   version: string,
 *   ttl_hours: number,
 *   critical_paths: string[]
 * }} StartupAttestationPolicy
 */

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/startup_attestation.js issue [--ttl-hours=N] [--strict]');
  console.log('  node systems/security/startup_attestation.js verify [--strict]');
  console.log('  node systems/security/startup_attestation.js status');
}

/**
 * @param {string[]} argv
 * @returns {Record<string, any> & { _: string[] }}
 */
function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @returns {StartupAttestationPolicy}
 */
function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  const ttlRaw = Number(raw.ttl_hours);
  const ttlHours = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, 240) : 24;
  const criticalPaths = Array.isArray(raw.critical_paths)
    ? raw.critical_paths.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  return {
    version: String(raw.version || '1.0'),
    ttl_hours: ttlHours,
    critical_paths: criticalPaths
  };
}

function resolveSecret() {
  const envPrimary = String(process.env.STARTUP_ATTESTATION_KEY || '').trim();
  if (envPrimary) return envPrimary;
  const envShared = String(process.env.SECRET_BROKER_KEY || '').trim();
  if (envShared) return envShared;
  for (const fp of SECRET_FILE_CANDIDATES) {
    const key = readTextSafe(fp);
    if (key) return key;
  }
  return '';
}

function hashCriticalPaths(policy) {
  const rows = [];
  const missing = [];
  for (const rel of policy.critical_paths) {
    const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm.includes('..')) continue;
    const abs = path.join(ROOT, norm);
    if (!fs.existsSync(abs)) {
      missing.push(norm);
      continue;
    }
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      missing.push(norm);
      continue;
    }
    rows.push({ path: norm, sha256: sha256File(abs), size_bytes: Number(st.size || 0) });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  missing.sort();
  return { rows, missing };
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(stableStringify(payload)).digest('hex');
}

function makeAttestation(policy, ttlHours) {
  const ts = nowIso();
  const expiresMs = Date.now() + Math.round(Math.max(1, ttlHours) * 3600000);
  const hashes = hashCriticalPaths(policy);
  return {
    type: 'startup_attestation',
    version: policy.version,
    ts,
    expires_at: new Date(expiresMs).toISOString(),
    ttl_hours: ttlHours,
    policy_path: path.relative(ROOT, POLICY_PATH).replace(/\\/g, '/'),
    critical_hashes: hashes.rows,
    missing_paths: hashes.missing
  };
}

function verifyAttestation(policy, state, secret) {
  if (!state || typeof state !== 'object' || state.type !== 'startup_attestation') {
    return { ok: false, reason: 'attestation_missing_or_invalid' };
  }
  if (!secret) return { ok: false, reason: 'attestation_key_missing' };

  const now = Date.now();
  const expires = Date.parse(String(state.expires_at || ''));
  if (!Number.isFinite(expires) || now > expires) {
    return { ok: false, reason: 'attestation_stale', expires_at: state.expires_at || null };
  }

  const signature = String(state.signature || '').trim().toLowerCase();
  if (!signature) {
    return { ok: false, reason: 'signature_missing' };
  }

  const payload = { ...state };
  delete payload.signature;
  const expected = signPayload(payload, secret);
  if (signature !== expected) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const current = hashCriticalPaths(policy);
  const expectedMap = new Map(
    (Array.isArray(state.critical_hashes) ? state.critical_hashes : [])
      .map((row) => [String(row && row.path || ''), String(row && row.sha256 || '')])
  );

  const drift = [];
  for (const row of current.rows) {
    const prior = expectedMap.get(row.path);
    if (!prior) {
      drift.push({ path: row.path, reason: 'new_path' });
      continue;
    }
    if (prior !== row.sha256) {
      drift.push({ path: row.path, reason: 'hash_mismatch' });
    }
  }
  for (const [p] of expectedMap.entries()) {
    if (!current.rows.find((x) => x.path === p)) {
      drift.push({ path: p, reason: 'missing_now' });
    }
  }
  if (drift.length) {
    return {
      ok: false,
      reason: 'critical_hash_drift',
      drift: drift.slice(0, 50)
    };
  }

  return { ok: true, reason: 'verified', expires_at: state.expires_at || null };
}

function cmdIssue(args) {
  const strict = args.strict === true;
  const policy = loadPolicy();
  const secret = resolveSecret();
  if (!secret) {
    const out = { ok: false, reason: 'attestation_key_missing' };
    process.stdout.write(JSON.stringify(out) + '\n');
    if (strict) process.exit(1);
    return;
  }

  const ttlRaw = Number(args['ttl-hours'] || args.ttl_hours);
  const ttlHours = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, 240) : policy.ttl_hours;
  const attestation = makeAttestation(policy, ttlHours);
  const signedAttestation = {
    ...attestation,
    signature: signPayload(attestation, secret)
  };
  writeJsonAtomic(STATE_PATH, signedAttestation);

  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'startup_attestation_issue',
    ok: true,
    expires_at: signedAttestation.expires_at,
    hashes: Array.isArray(signedAttestation.critical_hashes) ? signedAttestation.critical_hashes.length : 0,
    missing_paths: Array.isArray(signedAttestation.missing_paths) ? signedAttestation.missing_paths.length : 0
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'startup_attestation_issue',
    ts: signedAttestation.ts,
    expires_at: signedAttestation.expires_at,
    hashes: signedAttestation.critical_hashes.length,
    missing_paths: signedAttestation.missing_paths
  }) + '\n');
}

function cmdVerify(args) {
  const strict = args.strict === true;
  const policy = loadPolicy();
  const secret = resolveSecret();
  const state = readJsonSafe(STATE_PATH, null);
  const verdict = verifyAttestation(policy, state, secret);

  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'startup_attestation_verify',
    ok: verdict.ok === true,
    reason: verdict.reason || null
  });

  const out = {
    ok: verdict.ok === true,
    type: 'startup_attestation_verify',
    reason: verdict.reason || null,
    expires_at: verdict.expires_at || null,
    drift: verdict.drift || null
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && !out.ok) process.exit(1);
}

function cmdStatus() {
  const policy = loadPolicy();
  const state = readJsonSafe(STATE_PATH, null);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'startup_attestation_status',
    policy,
    state: state || null,
    state_path: path.relative(ROOT, STATE_PATH).replace(/\\/g, '/')
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'issue') return cmdIssue(args);
  if (cmd === 'verify' || cmd === 'run' || cmd === 'check') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : err;
    process.stdout.write(JSON.stringify({ ok: false, error: String(msg || 'startup_attestation_failed') }) + '\n');
    process.exit(1);
  }
}
export {};

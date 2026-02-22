// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const LEASE_STATE_PATH = process.env.CAPABILITY_LEASE_STATE_PATH
  ? path.resolve(process.env.CAPABILITY_LEASE_STATE_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_leases.json');
const LEASE_AUDIT_PATH = process.env.CAPABILITY_LEASE_AUDIT_PATH
  ? path.resolve(process.env.CAPABILITY_LEASE_AUDIT_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_leases.jsonl');
const LEASE_DEFAULT_TTL_SEC = Number(process.env.CAPABILITY_LEASE_DEFAULT_TTL_SEC || 300);
const LEASE_MIN_TTL_SEC = Number(process.env.CAPABILITY_LEASE_MIN_TTL_SEC || 30);
const LEASE_MAX_TTL_SEC = Number(process.env.CAPABILITY_LEASE_MAX_TTL_SEC || 3600);

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function base64urlEncode(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(input) {
  const raw = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4;
  const padded = pad === 0 ? raw : raw + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function leaseKey() {
  return normalizeText(process.env.CAPABILITY_LEASE_KEY || '', 4096);
}

function requireLeaseKey() {
  const key = leaseKey();
  if (!key) {
    return { ok: false, error: 'capability_lease_key_missing' };
  }
  return { ok: true, key };
}

function sign(payload, key) {
  return crypto.createHmac('sha256', key).update(String(payload), 'utf8').digest('hex');
}

function makeLeaseId() {
  return `lease_${crypto.randomBytes(8).toString('hex')}`;
}

function loadLeaseState() {
  const raw = readJsonSafe(LEASE_STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return { version: '1.0', issued: {}, consumed: {} };
  }
  return {
    version: '1.0',
    issued: raw.issued && typeof raw.issued === 'object' ? raw.issued : {},
    consumed: raw.consumed && typeof raw.consumed === 'object' ? raw.consumed : {}
  };
}

function saveLeaseState(state) {
  writeJsonAtomic(LEASE_STATE_PATH, state);
}

function audit(row) {
  appendJsonl(LEASE_AUDIT_PATH, {
    ts: nowIso(),
    ...(row && typeof row === 'object' ? row : {})
  });
}

function packToken(payload, key) {
  const p = base64urlEncode(JSON.stringify(payload));
  const sig = sign(p, key);
  return `${p}.${sig}`;
}

function unpackToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, error: 'token_malformed' };
  const body = String(parts[0] || '');
  const sig = String(parts[1] || '');
  let payload = null;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch {
    return { ok: false, error: 'token_payload_invalid' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'token_payload_invalid' };
  return { ok: true, body, sig, payload };
}

function issueLease(opts = {}) {
  const keyRes = requireLeaseKey();
  if (!keyRes.ok) return keyRes;
  const key = keyRes.key;

  const scope = normalizeText(opts.scope || '', 180);
  if (!scope) return { ok: false, error: 'scope_required' };
  const target = normalizeText(opts.target || '', 240) || null;
  const issuedBy = normalizeText(opts.issued_by || 'unknown', 120);
  const reason = normalizeText(opts.reason || '', 240) || null;
  const ttlSec = clampInt(opts.ttl_sec, LEASE_MIN_TTL_SEC, LEASE_MAX_TTL_SEC, LEASE_DEFAULT_TTL_SEC);
  const now = nowMs();
  const exp = now + (ttlSec * 1000);
  const payload = {
    v: '1.0',
    id: makeLeaseId(),
    scope,
    target,
    issued_at_ms: now,
    issued_at: new Date(now).toISOString(),
    expires_at_ms: exp,
    expires_at: new Date(exp).toISOString(),
    issued_by: issuedBy,
    reason,
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const token = packToken(payload, key);

  const state = loadLeaseState();
  state.issued[payload.id] = {
    id: payload.id,
    scope: payload.scope,
    target: payload.target,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    issued_by: payload.issued_by,
    reason: payload.reason
  };
  saveLeaseState(state);
  audit({
    type: 'capability_lease_issued',
    lease_id: payload.id,
    scope: payload.scope,
    target: payload.target,
    ttl_sec: ttlSec,
    issued_by: payload.issued_by
  });
  return {
    ok: true,
    lease_id: payload.id,
    scope: payload.scope,
    target: payload.target,
    expires_at: payload.expires_at,
    ttl_sec: ttlSec,
    token
  };
}

function verifyLease(token, opts = {}) {
  const keyRes = requireLeaseKey();
  if (!keyRes.ok) return keyRes;
  const key = keyRes.key;

  const unpacked = unpackToken(token);
  if (!unpacked.ok) return unpacked;
  const expectedSig = sign(unpacked.body, key);
  if (!crypto.timingSafeEqual(Buffer.from(unpacked.sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))) {
    return { ok: false, error: 'token_signature_invalid' };
  }

  const payload = unpacked.payload;
  const id = normalizeText(payload.id || '', 120);
  if (!id) return { ok: false, error: 'token_missing_id' };

  const scope = normalizeText(payload.scope || '', 180);
  const target = normalizeText(payload.target || '', 240) || null;
  const now = nowMs();
  const exp = Number(payload.expires_at_ms || 0);
  if (!Number.isFinite(exp) || exp <= now) {
    return { ok: false, error: 'lease_expired', lease_id: id, expires_at: payload.expires_at || null };
  }

  const wantScope = normalizeText(opts.scope || '', 180);
  if (wantScope && scope !== wantScope) {
    return { ok: false, error: 'scope_mismatch', lease_scope: scope, required_scope: wantScope, lease_id: id };
  }
  const wantTarget = normalizeText(opts.target || '', 240) || null;
  if (wantTarget && target && target !== wantTarget) {
    return { ok: false, error: 'target_mismatch', lease_target: target, required_target: wantTarget, lease_id: id };
  }

  const state = loadLeaseState();
  if (state.consumed[id]) {
    return { ok: false, error: 'lease_already_consumed', lease_id: id, consumed_at: state.consumed[id].ts || null };
  }
  if (!state.issued[id]) {
    return { ok: false, error: 'lease_unknown', lease_id: id };
  }

  if (opts.consume === true) {
    state.consumed[id] = {
      ts: nowIso(),
      reason: normalizeText(opts.consume_reason || 'consumed', 180) || 'consumed'
    };
    saveLeaseState(state);
    audit({
      type: 'capability_lease_consumed',
      lease_id: id,
      scope,
      target,
      reason: state.consumed[id].reason
    });
  }

  return {
    ok: true,
    lease_id: id,
    scope,
    target,
    expires_at: payload.expires_at || null,
    consumed: opts.consume === true
  };
}

module.exports = {
  issueLease,
  verifyLease,
  loadLeaseState,
  LEASE_STATE_PATH,
  LEASE_AUDIT_PATH
};

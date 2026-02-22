'use strict';

export {};

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SECRETS_DIR = process.env.SECRET_BROKER_SECRETS_DIR
  ? path.resolve(process.env.SECRET_BROKER_SECRETS_DIR)
  : path.join(os.homedir(), '.config', 'protheus', 'secrets');
const STATE_PATH = process.env.SECRET_BROKER_STATE_PATH
  ? path.resolve(process.env.SECRET_BROKER_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'secret_broker_state.json');
const AUDIT_PATH = process.env.SECRET_BROKER_AUDIT_PATH
  ? path.resolve(process.env.SECRET_BROKER_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'secret_broker_audit.jsonl');
const LEGACY_LOCAL_KEY_PATH = path.join(REPO_ROOT, 'state', 'security', 'secret_broker_key.txt');
const LOCAL_KEY_PATH = process.env.SECRET_BROKER_LOCAL_KEY_PATH
  ? path.resolve(process.env.SECRET_BROKER_LOCAL_KEY_PATH)
  : path.join(DEFAULT_SECRETS_DIR, 'secret_broker_key.txt');

const DEFAULT_TTL_SEC = Number(process.env.SECRET_BROKER_DEFAULT_TTL_SEC || 300);
const MIN_TTL_SEC = Number(process.env.SECRET_BROKER_MIN_TTL_SEC || 30);
const MAX_TTL_SEC = Number(process.env.SECRET_BROKER_MAX_TTL_SEC || 3600);

function nowMs(input: unknown): number {
  if (Number.isFinite(Number(input))) return Number(input);
  return Date.now();
}

function nowIso(ms?: unknown): string {
  return new Date(nowMs(ms)).toISOString();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizeText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function base64urlEncode(input: string): string {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(input: string): string {
  const raw = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4;
  const padded = pad === 0 ? raw : raw + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stableHash16(v: unknown): string {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function readTextSafe(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function loadOrCreateLocalKey(): string {
  const existing = readTextSafe(LOCAL_KEY_PATH);
  if (existing) return existing;
  const legacy = readTextSafe(LEGACY_LOCAL_KEY_PATH);
  if (legacy) return legacy;
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    ensureDir(path.dirname(LOCAL_KEY_PATH));
    fs.writeFileSync(LOCAL_KEY_PATH, generated + '\n', { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    // Fail closed: do not create fresh keys under tracked repo paths.
    return '';
  }
}

function secretBrokerKey(): string {
  const envKey = normalizeText(
    process.env.SECRET_BROKER_KEY
      || process.env.REQUEST_GATE_SECRET
      || process.env.CAPABILITY_LEASE_KEY
      || '',
    4096
  );
  if (envKey) return envKey;
  return normalizeText(loadOrCreateLocalKey(), 4096);
}

function requireSecretBrokerKey(): { ok: true; key: string } | { ok: false; error: string } {
  const key = secretBrokerKey();
  if (!key) {
    return { ok: false, error: 'secret_broker_key_missing' };
  }
  return { ok: true, key };
}

function sign(body: string, key: string): string {
  return crypto.createHmac('sha256', key).update(String(body), 'utf8').digest('hex');
}

function safeTimingEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function loadState(): Record<string, any> {
  const raw = readJsonSafe(STATE_PATH, null);
  if (!raw || typeof raw !== 'object') {
    return { version: '1.0', issued: {} };
  }
  return {
    version: '1.0',
    issued: raw.issued && typeof raw.issued === 'object' ? raw.issued : {}
  };
}

function saveState(state: Record<string, any>): void {
  writeJsonAtomic(STATE_PATH, state);
}

function audit(entry: Record<string, unknown>): void {
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    ...(entry && typeof entry === 'object' ? entry : {})
  });
}

function makeHandleId(): string {
  return `sh_${crypto.randomBytes(8).toString('hex')}`;
}

function parseHandle(handle: unknown): Record<string, any> {
  const raw = normalizeText(handle, 8192);
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, error: 'handle_malformed' };
  const body = String(parts[0] || '');
  const sig = String(parts[1] || '');
  let payload = null;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch {
    return { ok: false, error: 'handle_payload_invalid' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'handle_payload_invalid' };
  return { ok: true, body, sig, payload };
}

function loadMoltbookApiKey(): string {
  if (process.env.MOLTBOOK_TOKEN && String(process.env.MOLTBOOK_TOKEN).trim()) {
    return String(process.env.MOLTBOOK_TOKEN).trim();
  }
  const candidates = [
    path.join(DEFAULT_SECRETS_DIR, 'moltbook.credentials.json'),
    path.join(os.homedir(), '.config', 'moltbook', 'credentials.json'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'config', 'moltbook', 'credentials.json')
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const key = raw && raw.api_key ? String(raw.api_key).trim() : '';
      if (key) return key;
    } catch {
      // Continue to next candidate.
    }
  }
  return '';
}

function loadMoltstackApiKey(): string {
  if (process.env.MOLTSTACK_TOKEN && String(process.env.MOLTSTACK_TOKEN).trim()) {
    return String(process.env.MOLTSTACK_TOKEN).trim();
  }
  const candidates = [
    path.join(DEFAULT_SECRETS_DIR, 'moltstack.credentials.json'),
    path.join(os.homedir(), '.config', 'moltstack', 'credentials.json')
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const key = raw && raw.api_key ? String(raw.api_key).trim() : '';
      if (key) return key;
    } catch {
      // Continue to next candidate.
    }
  }
  return '';
}

const SECRET_LOADERS: Record<string, () => string> = {
  moltbook_api_key: loadMoltbookApiKey,
  moltstack_api_key: loadMoltstackApiKey
};

function loadSecretById(secretId: unknown): Record<string, any> {
  const key = normalizeText(secretId, 120);
  const loader = SECRET_LOADERS[key];
  if (typeof loader !== 'function') {
    return { ok: false, error: 'secret_id_unsupported', secret_id: key || null };
  }
  const value = String(loader() || '').trim();
  if (!value) {
    return { ok: false, error: 'secret_value_missing', secret_id: key };
  }
  return {
    ok: true,
    secret_id: key,
    value,
    value_hash: stableHash16(value)
  };
}

function issueSecretHandle(opts: Record<string, any> = {}): Record<string, any> {
  const keyRes = requireSecretBrokerKey();
  if (!keyRes.ok) return keyRes;

  const secretId = normalizeText(opts.secret_id || opts.secretId || '', 120);
  const scope = normalizeText(opts.scope || '', 180);
  const caller = normalizeText(opts.caller || 'unknown', 180);
  const reason = normalizeText(opts.reason || '', 240) || null;

  if (!secretId) return { ok: false, error: 'secret_id_required' };
  if (!scope) return { ok: false, error: 'scope_required' };

  const secret = loadSecretById(secretId);
  if (!secret.ok) {
    audit({
      type: 'secret_handle_issue_denied',
      secret_id: secretId,
      scope,
      caller,
      reason: secret.error || 'secret_missing'
    });
    return secret;
  }

  const ttlSec = clampInt(opts.ttl_sec, MIN_TTL_SEC, MAX_TTL_SEC, DEFAULT_TTL_SEC);
  const issuedMs = nowMs(opts.now_ms);
  const expiresMs = issuedMs + (ttlSec * 1000);
  const payload = {
    v: '1.0',
    handle_id: makeHandleId(),
    secret_id: secret.secret_id,
    scope,
    caller,
    reason,
    issued_at_ms: issuedMs,
    issued_at: nowIso(issuedMs),
    expires_at_ms: expiresMs,
    expires_at: nowIso(expiresMs),
    nonce: crypto.randomBytes(8).toString('hex')
  };

  const body = base64urlEncode(JSON.stringify(payload));
  const sig = sign(body, keyRes.key);
  const handle = `${body}.${sig}`;

  const state = loadState();
  state.issued[payload.handle_id] = {
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    reason: payload.reason,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    value_hash: secret.value_hash,
    resolve_count: 0,
    last_resolved_at: null
  };
  saveState(state);

  audit({
    type: 'secret_handle_issued',
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    ttl_sec: ttlSec,
    reason: payload.reason
  });

  return {
    ok: true,
    handle,
    handle_id: payload.handle_id,
    secret_id: payload.secret_id,
    scope: payload.scope,
    caller: payload.caller,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    ttl_sec: ttlSec
  };
}

function resolveSecretHandle(handle: unknown, opts: Record<string, any> = {}): Record<string, any> {
  const keyRes = requireSecretBrokerKey();
  if (!keyRes.ok) return keyRes;

  const parsed = parseHandle(handle);
  if (!parsed.ok) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: parsed.error || 'handle_invalid',
      scope: normalizeText(opts.scope || '', 180) || null,
      caller: normalizeText(opts.caller || '', 180) || null
    });
    return parsed;
  }

  const expectedSig = sign(parsed.body, keyRes.key);
  if (!safeTimingEqual(parsed.sig, expectedSig)) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_signature_invalid',
      handle_id: parsed.payload && parsed.payload.handle_id ? parsed.payload.handle_id : null
    });
    return { ok: false, error: 'handle_signature_invalid' };
  }

  const payload = parsed.payload;
  const handleId = normalizeText(payload.handle_id || '', 120);
  const secretId = normalizeText(payload.secret_id || '', 120);
  const scope = normalizeText(payload.scope || '', 180);
  const caller = normalizeText(payload.caller || '', 180);
  const expMs = Number(payload.expires_at_ms || 0);
  const now = nowMs(opts.now_ms);

  if (!handleId || !secretId || !scope || !caller) {
    return { ok: false, error: 'handle_payload_missing_fields' };
  }
  if (!Number.isFinite(expMs) || expMs <= now) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_expired',
      handle_id: handleId,
      secret_id: secretId
    });
    return { ok: false, error: 'handle_expired', handle_id: handleId, secret_id: secretId };
  }

  const requiredScope = normalizeText(opts.scope || '', 180);
  if (requiredScope && requiredScope !== scope) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'scope_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_scope: requiredScope,
      handle_scope: scope
    });
    return {
      ok: false,
      error: 'scope_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_scope: requiredScope,
      handle_scope: scope
    };
  }

  const requiredCaller = normalizeText(opts.caller || '', 180);
  if (requiredCaller && requiredCaller !== caller) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'caller_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_caller: requiredCaller,
      handle_caller: caller
    });
    return {
      ok: false,
      error: 'caller_mismatch',
      handle_id: handleId,
      secret_id: secretId,
      required_caller: requiredCaller,
      handle_caller: caller
    };
  }

  const state = loadState();
  if (!state.issued[handleId]) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: 'handle_unknown',
      handle_id: handleId,
      secret_id: secretId
    });
    return { ok: false, error: 'handle_unknown', handle_id: handleId, secret_id: secretId };
  }

  const secret = loadSecretById(secretId);
  if (!secret.ok) {
    audit({
      type: 'secret_handle_resolve_denied',
      reason: secret.error || 'secret_value_missing',
      handle_id: handleId,
      secret_id: secretId
    });
    return secret;
  }

  state.issued[handleId].resolve_count = Number(state.issued[handleId].resolve_count || 0) + 1;
  state.issued[handleId].last_resolved_at = nowIso(now);
  saveState(state);

  audit({
    type: 'secret_handle_resolved',
    handle_id: handleId,
    secret_id: secretId,
    scope,
    caller,
    resolve_count: state.issued[handleId].resolve_count
  });

  return {
    ok: true,
    handle_id: handleId,
    secret_id: secretId,
    scope,
    caller,
    expires_at: payload.expires_at || null,
    value: secret.value,
    value_hash: secret.value_hash
  };
}

module.exports = {
  issueSecretHandle,
  resolveSecretHandle,
  loadSecretById,
  STATE_PATH,
  AUDIT_PATH
};

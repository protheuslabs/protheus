const crypto = require('crypto');

type EnvelopePayloadInput = {
  source?: unknown;
  action?: unknown;
  ts?: unknown;
  nonce?: unknown;
  files?: unknown;
  kid?: unknown;
};

type EnvelopePayload = {
  source: string;
  action: string;
  kid: string;
  ts: number;
  nonce: string;
  files: string[];
};

function normalizeLower(v: unknown): string {
  return String(v || '').trim().toLowerCase();
}

function normalizeKeyId(v: unknown): string {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}

function secretKeyEnvVarName(kid: unknown): string {
  const keyId = normalizeKeyId(kid);
  if (!keyId) return '';
  return `REQUEST_GATE_SECRET_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function normalizeFiles(files: unknown): string[] {
  const arr = Array.isArray(files) ? files : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const f = String(raw || '').trim().replace(/\\/g, '/');
    if (!f) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function envelopePayload({ source, action, ts, nonce, files, kid }: EnvelopePayloadInput): EnvelopePayload {
  const src = normalizeLower(source) || 'local';
  const act = normalizeLower(action) || 'apply';
  const tsNum = Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Math.floor(Date.now() / 1000);
  const nonceVal = String(nonce || '').trim() || crypto.randomBytes(12).toString('hex');
  const fileList = normalizeFiles(files);
  const keyId = normalizeKeyId(kid);
  return {
    source: src,
    action: act,
    kid: keyId,
    ts: tsNum,
    nonce: nonceVal,
    files: fileList
  };
}

function canonicalEnvelopeString(payload: EnvelopePayloadInput): string {
  const p = envelopePayload(payload || {});
  return [
    'v1',
    `source=${p.source}`,
    `action=${p.action}`,
    `kid=${p.kid || ''}`,
    `ts=${p.ts}`,
    `nonce=${p.nonce}`,
    `files=${p.files.join(',')}`
  ].join('|');
}

function signEnvelope(payload: EnvelopePayloadInput, secret: unknown): string {
  const key = String(secret || '');
  if (!key) return '';
  return crypto
    .createHmac('sha256', key)
    .update(canonicalEnvelopeString(payload), 'utf8')
    .digest('hex');
}

function safeEqualHex(a: unknown, b: unknown): boolean {
  const ax = String(a || '').trim().toLowerCase();
  const bx = String(b || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(ax) || !/^[a-f0-9]{64}$/.test(bx)) return false;
  return crypto.timingSafeEqual(Buffer.from(ax, 'hex'), Buffer.from(bx, 'hex'));
}

function verifyEnvelope({ source, action, ts, nonce, files, kid, signature, secret, maxSkewSec = 900, nowSec }: EnvelopePayloadInput & { signature?: unknown; secret?: unknown; maxSkewSec?: unknown; nowSec?: unknown }) {
  const key = String(secret || '').trim();
  if (!key) return { ok: false, reason: 'secret_missing' as const };

  const payload = envelopePayload({ source, action, ts, nonce, files, kid });
  if (!Number.isFinite(Number(payload.ts)) || Number(payload.ts) <= 0) {
    return { ok: false, reason: 'timestamp_invalid' as const };
  }

  const now = Number.isFinite(Number(nowSec)) ? Math.floor(Number(nowSec)) : Math.floor(Date.now() / 1000);
  const maxSkew = Math.max(30, Number(maxSkewSec || 900));
  const skew = Math.abs(now - Number(payload.ts));
  if (skew > maxSkew) {
    return { ok: false, reason: 'timestamp_skew' as const, skew_sec: skew, max_skew_sec: maxSkew };
  }

  const expected = signEnvelope(payload, key);
  const provided = String(signature || '').trim().toLowerCase();
  if (!safeEqualHex(expected, provided)) {
    return { ok: false, reason: 'signature_mismatch' as const };
  }

  return { ok: true, reason: 'ok' as const, skew_sec: skew };
}

function stampGuardEnv(
  baseEnv: Record<string, unknown>,
  { source = 'local', action = 'apply', files = [], secret, ts, nonce, kid }: {
    source?: string;
    action?: string;
    files?: unknown[];
    secret?: unknown;
    ts?: unknown;
    nonce?: unknown;
    kid?: unknown;
  } = {}
): Record<string, unknown> {
  const env = { ...(baseEnv || {}) };
  const src = normalizeLower(source) || 'local';
  const act = normalizeLower(action) || 'apply';
  const keyId = normalizeKeyId(kid != null ? kid : env.REQUEST_KEY_ID);
  env.REQUEST_SOURCE = src;
  env.REQUEST_ACTION = act;
  if (keyId) env.REQUEST_KEY_ID = keyId;

  const keyFromKid = keyId ? String(env[secretKeyEnvVarName(keyId)] || '').trim() : '';
  const key = String(
    secret != null
      ? secret
      : keyFromKid || env.REQUEST_GATE_SECRET || ''
  ).trim();
  if (!key) return env;

  const payload = envelopePayload({ source: src, action: act, ts, nonce, files, kid: keyId });
  env.REQUEST_TS = String(payload.ts);
  env.REQUEST_NONCE = payload.nonce;
  env.REQUEST_SIG = signEnvelope(payload, key);
  return env;
}

function verifySignedEnvelopeFromEnv({
  env = process.env,
  files = [],
  secret,
  maxSkewSec = 900,
  nowSec
}: {
  env?: Record<string, unknown>;
  files?: string[];
  secret?: unknown;
  maxSkewSec?: number;
  nowSec?: number;
} = {}) {
  const e = env || {};
  const keyId = normalizeKeyId(e.REQUEST_KEY_ID);
  const keyFromKid = keyId ? String(e[secretKeyEnvVarName(keyId)] || '').trim() : '';
  const key = String(
    secret != null
      ? secret
      : keyFromKid || e.REQUEST_GATE_SECRET || ''
  ).trim();
  return verifyEnvelope({
    source: e.REQUEST_SOURCE,
    action: e.REQUEST_ACTION,
    kid: keyId,
    ts: e.REQUEST_TS,
    nonce: e.REQUEST_NONCE,
    files,
    signature: e.REQUEST_SIG,
    secret: key,
    maxSkewSec,
    nowSec
  });
}

export {
  envelopePayload,
  canonicalEnvelopeString,
  signEnvelope,
  verifyEnvelope,
  stampGuardEnv,
  verifySignedEnvelopeFromEnv,
  normalizeFiles,
  normalizeKeyId,
  secretKeyEnvVarName
};

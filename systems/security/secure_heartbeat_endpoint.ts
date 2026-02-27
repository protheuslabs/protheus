#!/usr/bin/env node
'use strict';
export {};

/**
 * secure_heartbeat_endpoint.js
 *
 * SEC-M06: hardened external heartbeat endpoint with:
 * - authn/authz (key-id + HMAC signature + clock skew control)
 * - rate limiting
 * - append-only audit + security alerts
 * - key issue/revoke/rotate lifecycle
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SECURE_HEARTBEAT_ENDPOINT_POLICY_PATH
  ? path.resolve(String(process.env.SECURE_HEARTBEAT_ENDPOINT_POLICY_PATH))
  : path.join(ROOT, 'config', 'secure_heartbeat_endpoint_policy.json');

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(absDir: string) {
  fs.mkdirSync(absDir, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, absPath);
}

function appendJsonl(absPath: string, row: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const raw = cleanText(v || fallbackRel, 360);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(ROOT, raw);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function hmacHex(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function safeEqHex(a: string, b: string) {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (aa.length === 0 || bb.length === 0 || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function defaultPolicy() {
  return {
    schema_id: 'secure_heartbeat_endpoint_policy',
    schema_version: '1.0',
    enabled: true,
    network: {
      host: '127.0.0.1',
      port: 8787,
      request_timeout_ms: 10000
    },
    auth: {
      required: true,
      max_clock_skew_sec: 120,
      rotate_previous_on_issue: true,
      default_key_ttl_hours: 720,
      max_key_ttl_hours: 2160
    },
    rate_limit: {
      window_sec: 60,
      max_requests_per_window: 180
    },
    paths: {
      keys_path: 'state/security/secure_heartbeat_endpoint/keys.json',
      state_path: 'state/security/secure_heartbeat_endpoint/state.json',
      latest_path: 'state/security/secure_heartbeat_endpoint/latest.json',
      audit_path: 'state/security/secure_heartbeat_endpoint/audit.jsonl',
      alerts_path: 'state/security/secure_heartbeat_endpoint/alerts.jsonl'
    },
    alerting: {
      emit_security_alerts: true,
      runbook_path: 'docs/OPERATOR_RUNBOOK.md',
      severity_on_invalid_signature: 'high',
      severity_on_rate_limit: 'medium'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const networkRaw = raw.network && typeof raw.network === 'object' ? raw.network : {};
  const authRaw = raw.auth && typeof raw.auth === 'object' ? raw.auth : {};
  const rateRaw = raw.rate_limit && typeof raw.rate_limit === 'object' ? raw.rate_limit : {};
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const alertRaw = raw.alerting && typeof raw.alerting === 'object' ? raw.alerting : {};
  return {
    schema_id: 'secure_heartbeat_endpoint_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    network: {
      host: cleanText(networkRaw.host || base.network.host, 120) || base.network.host,
      port: clampInt(networkRaw.port, 1, 65535, base.network.port),
      request_timeout_ms: clampInt(networkRaw.request_timeout_ms, 1000, 120000, base.network.request_timeout_ms)
    },
    auth: {
      required: authRaw.required !== false,
      max_clock_skew_sec: clampInt(authRaw.max_clock_skew_sec, 0, 86400, base.auth.max_clock_skew_sec),
      rotate_previous_on_issue: authRaw.rotate_previous_on_issue !== false,
      default_key_ttl_hours: clampInt(authRaw.default_key_ttl_hours, 1, 24 * 365, base.auth.default_key_ttl_hours),
      max_key_ttl_hours: clampInt(authRaw.max_key_ttl_hours, 1, 24 * 365, base.auth.max_key_ttl_hours)
    },
    rate_limit: {
      window_sec: clampInt(rateRaw.window_sec, 1, 3600, base.rate_limit.window_sec),
      max_requests_per_window: clampInt(rateRaw.max_requests_per_window, 1, 100000, base.rate_limit.max_requests_per_window)
    },
    paths: {
      keys_path: resolvePath(pathsRaw.keys_path, base.paths.keys_path),
      state_path: resolvePath(pathsRaw.state_path, base.paths.state_path),
      latest_path: resolvePath(pathsRaw.latest_path, base.paths.latest_path),
      audit_path: resolvePath(pathsRaw.audit_path, base.paths.audit_path),
      alerts_path: resolvePath(pathsRaw.alerts_path, base.paths.alerts_path)
    },
    alerting: {
      emit_security_alerts: alertRaw.emit_security_alerts !== false,
      runbook_path: resolvePath(alertRaw.runbook_path, base.alerting.runbook_path),
      severity_on_invalid_signature: normalizeToken(
        alertRaw.severity_on_invalid_signature || base.alerting.severity_on_invalid_signature,
        40
      ) || base.alerting.severity_on_invalid_signature,
      severity_on_rate_limit: normalizeToken(
        alertRaw.severity_on_rate_limit || base.alerting.severity_on_rate_limit,
        40
      ) || base.alerting.severity_on_rate_limit
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadKeyStore(policy: AnyObj) {
  const raw = readJson(policy.paths.keys_path, {});
  const keysRaw = Array.isArray(raw.keys) ? raw.keys : [];
  const keys = keysRaw.map((row: AnyObj) => ({
    key_id: normalizeToken(row.key_id || '', 120),
    client_id: normalizeToken(row.client_id || '', 120),
    secret: cleanText(row.secret || '', 2048),
    status: normalizeToken(row.status || 'active', 40) || 'active',
    created_at: cleanText(row.created_at || '', 40) || null,
    expires_at: cleanText(row.expires_at || '', 40) || null,
    revoked_at: cleanText(row.revoked_at || '', 40) || null,
    reason: cleanText(row.reason || '', 240) || null
  })).filter((row: AnyObj) => row.key_id && row.client_id && row.secret);
  return {
    schema_id: 'secure_heartbeat_endpoint_keys',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    keys
  };
}

function saveKeyStore(policy: AnyObj, store: AnyObj) {
  writeJsonAtomic(policy.paths.keys_path, {
    schema_id: 'secure_heartbeat_endpoint_keys',
    schema_version: '1.0',
    updated_at: nowIso(),
    keys: Array.isArray(store.keys) ? store.keys : []
  });
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'secure_heartbeat_endpoint_state',
    schema_version: '1.0',
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    totals: {
      accepted: clampInt(raw.totals && raw.totals.accepted, 0, 10 ** 12, 0),
      denied: clampInt(raw.totals && raw.totals.denied, 0, 10 ** 12, 0)
    },
    windows: raw.windows && typeof raw.windows === 'object' ? raw.windows : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'secure_heartbeat_endpoint_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    totals: {
      accepted: clampInt(state.totals && state.totals.accepted, 0, 10 ** 12, 0),
      denied: clampInt(state.totals && state.totals.denied, 0, 10 ** 12, 0)
    },
    windows: state.windows && typeof state.windows === 'object' ? state.windows : {}
  });
}

function isExpired(key: AnyObj, nowMs: number) {
  if (!key || !key.expires_at) return false;
  const ts = Date.parse(String(key.expires_at));
  if (!Number.isFinite(ts)) return false;
  return ts <= nowMs;
}

function lookupActiveKey(policy: AnyObj, keyId: string, nowMs: number) {
  const store = loadKeyStore(policy);
  const key = (store.keys || []).find((row: AnyObj) => row.key_id === keyId) || null;
  if (!key) return { store, key: null, reason: 'key_not_found' };
  if (key.status !== 'active') return { store, key: null, reason: 'key_not_active' };
  if (isExpired(key, nowMs)) return { store, key: null, reason: 'key_expired' };
  return { store, key, reason: null };
}

function consumeRate(policy: AnyObj, state: AnyObj, keyId: string, nowMs: number) {
  const bucket = state.windows[keyId] && typeof state.windows[keyId] === 'object'
    ? state.windows[keyId]
    : {
        window_started_at: nowIso(),
        window_started_ms: nowMs,
        count: 0
      };
  const windowSec = Number(policy.rate_limit.window_sec || 60);
  const maxPerWindow = Number(policy.rate_limit.max_requests_per_window || 180);
  const ageMs = Math.max(0, nowMs - Number(bucket.window_started_ms || nowMs));
  if (ageMs >= windowSec * 1000) {
    bucket.window_started_ms = nowMs;
    bucket.window_started_at = nowIso();
    bucket.count = 0;
  }
  bucket.count = Number(bucket.count || 0) + 1;
  state.windows[keyId] = bucket;
  const allowed = bucket.count <= maxPerWindow;
  const retryAfter = allowed
    ? 0
    : Math.max(1, Math.ceil((windowSec * 1000 - (nowMs - Number(bucket.window_started_ms || nowMs))) / 1000));
  return {
    allowed,
    count: bucket.count,
    max: maxPerWindow,
    retry_after_sec: retryAfter
  };
}

function emitAudit(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.paths.audit_path, {
    ts: nowIso(),
    type: 'secure_heartbeat_endpoint_audit',
    ...row
  });
}

function emitAlert(policy: AnyObj, row: AnyObj) {
  if (policy.alerting.emit_security_alerts !== true) return;
  appendJsonl(policy.paths.alerts_path, {
    ts: nowIso(),
    type: 'secure_heartbeat_endpoint_alert',
    ...row
  });
}

function issueKey(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const clientId = normalizeToken(args['client-id'] || args.client_id || '', 120);
  if (!clientId) {
    return { ok: false, type: 'secure_heartbeat_endpoint_issue_key', error: 'client_id_required' };
  }
  const apply = toBool(args.apply, true);
  const ttlHours = clampInt(
    args['ttl-hours'] || args.ttl_hours,
    1,
    Number(policy.auth.max_key_ttl_hours || 24 * 365),
    Number(policy.auth.default_key_ttl_hours || 720)
  );
  const now = new Date();
  const nowTs = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
  const keyId = `hbk_${crypto.randomBytes(8).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const store = loadKeyStore(policy);

  if (policy.auth.rotate_previous_on_issue === true) {
    for (const row of store.keys) {
      if (row.client_id === clientId && row.status === 'active') {
        row.status = 'revoked';
        row.revoked_at = nowTs;
        row.reason = 'rotated_on_issue';
      }
    }
  }
  const created = {
    key_id: keyId,
    client_id: clientId,
    secret,
    status: 'active',
    created_at: nowTs,
    expires_at: expiresAt,
    revoked_at: null,
    reason: null
  };
  store.keys.push(created);
  if (apply) saveKeyStore(policy, store);
  emitAudit(policy, {
    action: 'issue_key',
    ok: true,
    apply,
    key_id: keyId,
    client_id: clientId,
    ttl_hours: ttlHours
  });
  return {
    ok: true,
    type: 'secure_heartbeat_endpoint_issue_key',
    ts: nowTs,
    applied: apply,
    key_id: keyId,
    client_id: clientId,
    secret,
    expires_at: expiresAt
  };
}

function revokeKey(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  if (!keyId) return { ok: false, type: 'secure_heartbeat_endpoint_revoke_key', error: 'key_id_required' };
  const apply = toBool(args.apply, true);
  const reason = cleanText(args.reason || 'manual_revoke', 200) || 'manual_revoke';
  const store = loadKeyStore(policy);
  const key = store.keys.find((row: AnyObj) => row.key_id === keyId);
  if (!key) return { ok: false, type: 'secure_heartbeat_endpoint_revoke_key', error: 'key_not_found', key_id: keyId };
  key.status = 'revoked';
  key.revoked_at = nowIso();
  key.reason = reason;
  if (apply) saveKeyStore(policy, store);
  emitAudit(policy, { action: 'revoke_key', ok: true, apply, key_id: keyId, reason });
  return { ok: true, type: 'secure_heartbeat_endpoint_revoke_key', applied: apply, key_id: keyId, reason };
}

function receiveHeartbeat(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  if (policy.enabled !== true) {
    return { ok: false, type: 'secure_heartbeat_endpoint_receive', error: 'endpoint_disabled' };
  }
  const payloadText = String(args['payload-json'] || args.payload_json || '').trim();
  if (!payloadText) {
    return { ok: false, type: 'secure_heartbeat_endpoint_receive', error: 'payload_json_required' };
  }
  let payload: AnyObj = {};
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { ok: false, type: 'secure_heartbeat_endpoint_receive', error: 'payload_json_invalid' };
  }

  const keyId = normalizeToken(args['key-id'] || args.key_id || '', 120);
  const tsRaw = cleanText(args.ts || '', 40) || String(Math.floor(Date.now() / 1000));
  const signature = cleanText(args.signature || '', 200) || '';
  const sourceIp = cleanText(args.ip || args['source-ip'] || 'unknown', 120) || 'unknown';
  const nowMs = Date.now();
  const state = loadState(policy);
  const reasons: string[] = [];
  let clientId = null;

  if (policy.auth.required === true) {
    if (!keyId) reasons.push('key_id_missing');
    if (!signature) reasons.push('signature_missing');
    const tsNum = Number(tsRaw);
    if (!Number.isFinite(tsNum)) reasons.push('timestamp_invalid');
    const skew = Math.abs(Math.floor(nowMs / 1000) - Math.floor(tsNum || 0));
    if (Number.isFinite(tsNum) && skew > Number(policy.auth.max_clock_skew_sec || 120)) {
      reasons.push('timestamp_skew_exceeded');
    }
    if (!reasons.length) {
      const keyLookup = lookupActiveKey(policy, keyId, nowMs);
      if (!keyLookup.key) reasons.push(String(keyLookup.reason || 'key_invalid'));
      if (keyLookup.key) {
        clientId = keyLookup.key.client_id;
        const expected = hmacHex(keyLookup.key.secret, `${tsRaw}.${payloadText}`);
        if (!safeEqHex(expected, signature)) reasons.push('signature_mismatch');
      }
    }
  }

  let rate = { allowed: true, count: 0, max: Number(policy.rate_limit.max_requests_per_window || 180), retry_after_sec: 0 };
  if (!reasons.length && keyId) {
    rate = consumeRate(policy, state, keyId, nowMs);
    if (!rate.allowed) reasons.push('rate_limited');
  }

  const accepted = reasons.length === 0;
  if (accepted) state.totals.accepted += 1;
  else state.totals.denied += 1;
  saveState(policy, state);

  const row = {
    action: 'receive_heartbeat',
    ok: accepted,
    source_ip: sourceIp,
    key_id: keyId || null,
    client_id: clientId,
    heartbeat_id: cleanText(payload.heartbeat_id || '', 160) || null,
    payload_ts: cleanText(payload.ts || '', 40) || null,
    reasons,
    rate_limit: rate
  };
  emitAudit(policy, row);
  if (!accepted) {
    const severity = reasons.includes('rate_limited')
      ? policy.alerting.severity_on_rate_limit
      : policy.alerting.severity_on_invalid_signature;
    emitAlert(policy, {
      action: 'heartbeat_denied',
      severity,
      reasons,
      key_id: keyId || null,
      source_ip: sourceIp,
      runbook_path: rel(policy.alerting.runbook_path)
    });
  }

  if (accepted) {
    writeJsonAtomic(policy.paths.latest_path, {
      schema_id: 'secure_heartbeat_endpoint_latest',
      schema_version: '1.0',
      ts: nowIso(),
      key_id: keyId,
      client_id: clientId,
      source_ip: sourceIp,
      payload
    });
  }

  return {
    ok: accepted,
    type: 'secure_heartbeat_endpoint_receive',
    ts: nowIso(),
    accepted,
    reasons,
    key_id: keyId || null,
    client_id: clientId,
    rate_limit: rate
  };
}

function status(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const state = loadState(policy);
  const keyStore = loadKeyStore(policy);
  const latest = readJson(policy.paths.latest_path, null);
  const activeKeys = keyStore.keys.filter((row: AnyObj) => row.status === 'active');
  return {
    ok: true,
    type: 'secure_heartbeat_endpoint_status',
    ts: nowIso(),
    enabled: policy.enabled === true,
    network: policy.network,
    auth_required: policy.auth.required === true,
    key_counts: {
      total: keyStore.keys.length,
      active: activeKeys.length
    },
    totals: state.totals,
    latest_heartbeat_id: latest && latest.payload ? cleanText(latest.payload.heartbeat_id || '', 160) || null : null,
    paths: {
      policy_path: rel(policy.policy_path),
      keys_path: rel(policy.paths.keys_path),
      state_path: rel(policy.paths.state_path),
      latest_path: rel(policy.paths.latest_path),
      audit_path: rel(policy.paths.audit_path),
      alerts_path: rel(policy.paths.alerts_path),
      runbook_path: rel(policy.alerting.runbook_path)
    }
  };
}

function verify(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, false);
  const checks: AnyObj[] = [];
  function add(id: string, ok: boolean, detail: string) {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 260) });
  }
  add('policy:enabled', policy.enabled === true, `enabled=${policy.enabled ? '1' : '0'}`);
  add('auth:required', policy.auth.required === true, `auth_required=${policy.auth.required ? '1' : '0'}`);
  add(
    'rate_limit:positive',
    Number(policy.rate_limit.window_sec || 0) > 0 && Number(policy.rate_limit.max_requests_per_window || 0) > 0,
    `window_sec=${policy.rate_limit.window_sec} max_requests_per_window=${policy.rate_limit.max_requests_per_window}`
  );
  const runbookSrc = fs.existsSync(policy.alerting.runbook_path)
    ? fs.readFileSync(policy.alerting.runbook_path, 'utf8')
    : '';
  add(
    'alerting:runbook_hook',
    runbookSrc.includes('secure_heartbeat_endpoint.js'),
    `runbook_path=${rel(policy.alerting.runbook_path)}`
  );
  const out = {
    ok: checks.every((row) => row.ok === true),
    type: 'secure_heartbeat_endpoint_verify',
    ts: nowIso(),
    checks
  };
  if (strict && !out.ok) process.exitCode = 1;
  return out;
}

function serve(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const host = cleanText(args.host || policy.network.host, 120) || policy.network.host;
  const port = clampInt(args.port, 1, 65535, policy.network.port);
  const timeoutMs = clampInt(policy.network.request_timeout_ms, 1000, 120000, 10000);
  const server = http.createServer((req: AnyObj, res: AnyObj) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '/');
    if (method === 'GET' && url === '/v1/status') {
      const out = status({ policy: args.policy });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(`${JSON.stringify(out)}\n`);
      return;
    }
    if (method !== 'POST' || url !== '/v1/heartbeat') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(`${JSON.stringify({ ok: false, error: 'not_found' })}\n`);
      return;
    }
    req.setTimeout(timeoutMs);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 1024 * 1024) req.destroy(new Error('payload_too_large'));
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(`${JSON.stringify({ ok: false, error: 'request_read_failed' })}\n`);
      }
    });
    req.on('end', () => {
      const payloadText = Buffer.concat(chunks).toString('utf8');
      const out = receiveHeartbeat({
        policy: args.policy,
        'payload-json': payloadText,
        'key-id': req.headers['x-heartbeat-key-id'],
        ts: req.headers['x-heartbeat-ts'],
        signature: req.headers['x-heartbeat-signature'],
        ip: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown'
      });
      res.statusCode = out.ok ? 202 : 401;
      res.setHeader('content-type', 'application/json');
      res.end(`${JSON.stringify(out)}\n`);
    });
  });
  server.listen(port, host);
  const out = {
    ok: true,
    type: 'secure_heartbeat_endpoint_serve',
    ts: nowIso(),
    host,
    port
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/secure_heartbeat_endpoint.js issue-key --client-id=<id> [--ttl-hours=720] [--apply=1|0]');
  console.log('  node systems/security/secure_heartbeat_endpoint.js revoke-key --key-id=<id> [--reason=<text>] [--apply=1|0]');
  console.log('  node systems/security/secure_heartbeat_endpoint.js receive --payload-json=\'{...}\' --key-id=<id> --ts=<unix-sec> --signature=<hex> [--ip=<addr>]');
  console.log('  node systems/security/secure_heartbeat_endpoint.js verify [--strict=1|0]');
  console.log('  node systems/security/secure_heartbeat_endpoint.js status');
  console.log('  node systems/security/secure_heartbeat_endpoint.js serve [--host=127.0.0.1] [--port=8787]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'issue-key') out = issueKey(args);
  else if (cmd === 'revoke-key') out = revokeKey(args);
  else if (cmd === 'receive') out = receiveHeartbeat(args);
  else if (cmd === 'verify') out = verify(args);
  else if (cmd === 'status') out = status(args);
  else if (cmd === 'serve') return serve(args);
  else out = { ok: false, type: 'secure_heartbeat_endpoint', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const strictVerify = cmd === 'verify' && toBool(args.strict, false);
  if (out && out.ok === false && (cmd !== 'verify' || strictVerify)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'secure_heartbeat_endpoint',
      error: cleanText((err as AnyObj)?.message || err || 'secure_heartbeat_endpoint_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  issueKey,
  revokeKey,
  receiveHeartbeat,
  status,
  verify
};

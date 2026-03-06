#!/usr/bin/env node
'use strict';
export {};

/**
 * remote_emergency_halt.js
 *
 * Signed off-host emergency halt lane with nonce/TTL replay protection,
 * optional policy-root authorization, lease revocation, and time-boxed secure purge.
 *
 * Usage:
 *   node systems/security/remote_emergency_halt.js status
 *   node systems/security/remote_emergency_halt.js sign-halt --approval-note="<text>" [--scope=all] [--ttl-sec=120]
 *   node systems/security/remote_emergency_halt.js sign-purge --pending-id=<id>
 *   node systems/security/remote_emergency_halt.js receive --command='<json>'
 *   node systems/security/remote_emergency_halt.js receive-b64 --command-b64='<base64>'
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { engageEmergencyStop } = require('../../lib/emergency_stop');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.REMOTE_EMERGENCY_HALT_POLICY_PATH
  ? path.resolve(process.env.REMOTE_EMERGENCY_HALT_POLICY_PATH)
  : path.join(ROOT, 'config', 'remote_emergency_halt_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    const tok = String(arg || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx === -1) out[tok.slice(2)] = true;
    else out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function sha16(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hmacHex(payload: unknown, key: string) {
  return crypto.createHmac('sha256', String(key || '')).update(stableStringify(payload)).digest('hex');
}

function timingSafeEqHex(a: string, b: string) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
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

function encodeB64(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeB64(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function runJsonCommand(args: string[], timeoutMs = 15000) {
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: clampInt(timeoutMs, 200, 120000, 15000)
  });
  return {
    status: Number.isInteger(res && res.status) ? Number(res.status) : 1,
    payload: parseJsonPayload(res && res.stdout),
    stdout: clean(res && res.stdout || '', 2000),
    stderr: clean(res && res.stderr || '', 2000)
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    key_env: 'REMOTE_EMERGENCY_HALT_KEY',
    max_ttl_seconds: 300,
    max_clock_skew_seconds: 30,
    replay_nonce_ttl_seconds: 86400,
    paths: {
      state: 'state/security/remote_emergency_halt_state.json',
      nonce_store: 'state/security/remote_emergency_halt_nonces.json',
      audit: 'state/security/remote_emergency_halt_audit.jsonl',
      black_box_attestation_dir: 'state/security/black_box_ledger/attestations'
    },
    policy_root: {
      enabled: true,
      script: 'systems/security/policy_rootd.js',
      scope: 'workflow_external_orchestration',
      source: 'remote_emergency_halt',
      timeout_ms: 15000,
      require_lease_token: true
    },
    revoke_leases: {
      enabled: true,
      lease_state_path: 'state/security/capability_leases.json',
      lease_audit_path: 'state/security/capability_leases.jsonl'
    },
    secure_purge: {
      enabled: true,
      allow_live_purge: false,
      window_minutes_default: 15,
      window_minutes_max: 60,
      confirm_phrase: 'I UNDERSTAND THIS PURGES SENSITIVE STATE',
      quarantine_dir: 'research/security/remote_halt_purge',
      sensitive_paths: [
        'state/security/soul_token_guard.json',
        'state/security/release_attestations.jsonl',
        'state/security/capability_leases.json',
        'state/security/capability_leases.jsonl'
      ]
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const pathsRaw = raw && raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const prRaw = raw && raw.policy_root && typeof raw.policy_root === 'object' ? raw.policy_root : {};
  const revokeRaw = raw && raw.revoke_leases && typeof raw.revoke_leases === 'object' ? raw.revoke_leases : {};
  const purgeRaw = raw && raw.secure_purge && typeof raw.secure_purge === 'object' ? raw.secure_purge : {};
  return {
    version: clean(raw.version || base.version, 24) || '1.0',
    enabled: toBool(raw.enabled, true),
    key_env: clean(raw.key_env || base.key_env, 80) || base.key_env,
    max_ttl_seconds: clampInt(raw.max_ttl_seconds, 10, 86400, base.max_ttl_seconds),
    max_clock_skew_seconds: clampInt(raw.max_clock_skew_seconds, 0, 600, base.max_clock_skew_seconds),
    replay_nonce_ttl_seconds: clampInt(raw.replay_nonce_ttl_seconds, 60, 365 * 24 * 60 * 60, base.replay_nonce_ttl_seconds),
    paths: {
      state: resolvePath(pathsRaw.state, base.paths.state),
      nonce_store: resolvePath(pathsRaw.nonce_store, base.paths.nonce_store),
      audit: resolvePath(pathsRaw.audit, base.paths.audit),
      black_box_attestation_dir: resolvePath(pathsRaw.black_box_attestation_dir, base.paths.black_box_attestation_dir)
    },
    policy_root: {
      enabled: toBool(prRaw.enabled, true),
      script: resolvePath(prRaw.script, base.policy_root.script),
      scope: clean(prRaw.scope || base.policy_root.scope, 120) || base.policy_root.scope,
      source: clean(prRaw.source || base.policy_root.source, 120) || base.policy_root.source,
      timeout_ms: clampInt(prRaw.timeout_ms, 200, 120000, base.policy_root.timeout_ms),
      require_lease_token: toBool(prRaw.require_lease_token, true)
    },
    revoke_leases: {
      enabled: toBool(revokeRaw.enabled, true),
      lease_state_path: resolvePath(revokeRaw.lease_state_path, base.revoke_leases.lease_state_path),
      lease_audit_path: resolvePath(revokeRaw.lease_audit_path, base.revoke_leases.lease_audit_path)
    },
    secure_purge: {
      enabled: toBool(purgeRaw.enabled, true),
      allow_live_purge: toBool(purgeRaw.allow_live_purge, false),
      window_minutes_default: clampInt(purgeRaw.window_minutes_default, 1, 24 * 60, base.secure_purge.window_minutes_default),
      window_minutes_max: clampInt(purgeRaw.window_minutes_max, 1, 24 * 60, base.secure_purge.window_minutes_max),
      confirm_phrase: clean(purgeRaw.confirm_phrase || base.secure_purge.confirm_phrase, 240) || base.secure_purge.confirm_phrase,
      quarantine_dir: resolvePath(purgeRaw.quarantine_dir, base.secure_purge.quarantine_dir),
      sensitive_paths: Array.isArray(purgeRaw.sensitive_paths)
        ? purgeRaw.sensitive_paths.map((v: unknown) => resolvePath(v, '')).filter(Boolean)
        : base.secure_purge.sensitive_paths.map((v: unknown) => resolvePath(v, ''))
    }
  };
}

function resolveKey(policy: AnyObj) {
  const envName = clean(policy && policy.key_env || '', 80) || 'REMOTE_EMERGENCY_HALT_KEY';
  const key = clean(process.env[envName] || '', 4096);
  return { env_name: envName, key };
}

function appendBlackBox(policy: AnyObj, row: AnyObj) {
  const date = nowIso().slice(0, 10);
  const filePath = path.join(policy.paths.black_box_attestation_dir, `${date}.jsonl`);
  appendJsonl(filePath, {
    ts: nowIso(),
    type: 'cross_runtime_attestation',
    system: 'remote_emergency_halt',
    ...row
  });
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.paths.state, null);
  if (!raw || typeof raw !== 'object') {
    return {
      schema_id: 'remote_emergency_halt_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      last_halt: null,
      pending_purge: null
    };
  }
  return {
    schema_id: 'remote_emergency_halt_state',
    schema_version: '1.0',
    updated_at: clean(raw.updated_at || '', 48) || nowIso(),
    last_halt: raw.last_halt && typeof raw.last_halt === 'object' ? raw.last_halt : null,
    pending_purge: raw.pending_purge && typeof raw.pending_purge === 'object' ? raw.pending_purge : null
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.paths.state, {
    ...(state && typeof state === 'object' ? state : {}),
    updated_at: nowIso()
  });
}

function loadNonceStore(policy: AnyObj) {
  const raw = readJson(policy.paths.nonce_store, null);
  if (!raw || typeof raw !== 'object') return { nonces: {} };
  return {
    nonces: raw.nonces && typeof raw.nonces === 'object' ? raw.nonces : {}
  };
}

function saveNonceStore(policy: AnyObj, store: AnyObj) {
  writeJsonAtomic(policy.paths.nonce_store, {
    nonces: store && store.nonces && typeof store.nonces === 'object' ? store.nonces : {}
  });
}

function pruneNonces(policy: AnyObj, store: AnyObj) {
  const out: AnyObj = { nonces: {} };
  const now = Date.now();
  const src = store && store.nonces && typeof store.nonces === 'object' ? store.nonces : {};
  for (const [nonce, row] of Object.entries(src)) {
    const exp = Date.parse(String((row as AnyObj).expires_at || ''));
    const replayExp = Number.isFinite(exp)
      ? exp + Number(policy.replay_nonce_ttl_seconds || 0) * 1000
      : now + Number(policy.replay_nonce_ttl_seconds || 0) * 1000;
    if (replayExp > now) out.nonces[nonce] = row;
  }
  return out;
}

function verifySignedCommand(policy: AnyObj, signed: AnyObj) {
  const keyInfo = resolveKey(policy);
  if (!keyInfo.key) return { ok: false, reason: 'signing_key_missing', key_env: keyInfo.env_name };
  if (!signed || typeof signed !== 'object') return { ok: false, reason: 'command_payload_invalid' };

  const signature = clean(signed.signature || '', 2000);
  const payload = { ...signed };
  delete payload.signature;
  const expectedSig = hmacHex(payload, keyInfo.key);
  if (!signature || !timingSafeEqHex(signature, expectedSig)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  const issuedAt = Date.parse(String(payload.issued_at || ''));
  const expiresAt = Date.parse(String(payload.expires_at || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: 'ttl_invalid' };
  }
  const ttlSec = Math.floor((expiresAt - issuedAt) / 1000);
  if (ttlSec < 1 || ttlSec > Number(policy.max_ttl_seconds || 300)) {
    return { ok: false, reason: 'ttl_out_of_range', ttl_seconds: ttlSec };
  }
  const now = Date.now();
  const skewMs = Number(policy.max_clock_skew_seconds || 0) * 1000;
  if (issuedAt > now + skewMs) return { ok: false, reason: 'issued_at_in_future' };
  if (expiresAt < now) return { ok: false, reason: 'command_expired' };

  const nonce = clean(payload.nonce || '', 200);
  if (!nonce) return { ok: false, reason: 'nonce_required' };
  const store = pruneNonces(policy, loadNonceStore(policy));
  if (store.nonces[nonce]) {
    saveNonceStore(policy, store);
    return { ok: false, reason: 'replay_nonce', nonce };
  }
  store.nonces[nonce] = {
    seen_at: nowIso(),
    expires_at: new Date(expiresAt).toISOString(),
    command_id: clean(payload.command_id || '', 120) || null
  };
  saveNonceStore(policy, store);

  return { ok: true, payload, nonce };
}

function authorizePolicyRoot(policy: AnyObj, payload: AnyObj) {
  if (!policy.policy_root.enabled) return { ok: true, skipped: true };
  if (!fs.existsSync(policy.policy_root.script)) return { ok: false, reason: 'policy_root_script_missing' };
  const approvalNote = clean(payload.approval_note || '', 320);
  const leaseToken = clean(payload.policy_root_lease_token || '', 8192);
  if (policy.policy_root.require_lease_token === true && !leaseToken) {
    return { ok: false, reason: 'policy_root_lease_token_required' };
  }
  const args = [
    policy.policy_root.script,
    'authorize',
    `--scope=${clean(policy.policy_root.scope || 'workflow_external_orchestration', 120) || 'workflow_external_orchestration'}`,
    `--target=${clean(payload.scope || 'all', 120) || 'all'}`,
    `--source=${clean(policy.policy_root.source || 'remote_emergency_halt', 120) || 'remote_emergency_halt'}`,
    `--approval-note=${approvalNote || 'remote signed halt'}`
  ];
  if (leaseToken) args.push(`--lease-token=${leaseToken}`);
  const res = runJsonCommand(args, policy.policy_root.timeout_ms);
  if (!(res.payload && res.payload.ok === true)) {
    return {
      ok: false,
      reason: 'policy_root_denied',
      decision: res.payload || null,
      stderr: res.stderr || null
    };
  }
  return { ok: true, decision: res.payload };
}

function revokeActiveLeases(policy: AnyObj, commandId: string) {
  const result = {
    attempted: false,
    revoked_count: 0,
    lease_state_path: relPath(policy.revoke_leases.lease_state_path),
    lease_audit_path: relPath(policy.revoke_leases.lease_audit_path)
  };
  if (!policy.revoke_leases.enabled) return result;
  result.attempted = true;
  const state = readJson(policy.revoke_leases.lease_state_path, {
    version: '1.0',
    issued: {},
    consumed: {}
  });
  const issued = state && state.issued && typeof state.issued === 'object' ? state.issued : {};
  const consumed = state && state.consumed && typeof state.consumed === 'object' ? state.consumed : {};
  const ts = nowIso();
  let revoked = 0;
  for (const leaseId of Object.keys(issued)) {
    if (consumed[leaseId]) continue;
    consumed[leaseId] = {
      ts,
      reason: 'remote_emergency_halt_revoke',
      command_id: commandId || null
    };
    revoked += 1;
    appendJsonl(policy.revoke_leases.lease_audit_path, {
      ts,
      type: 'capability_lease_revoked_remote_halt',
      lease_id: leaseId,
      command_id: commandId || null
    });
  }
  writeJsonAtomic(policy.revoke_leases.lease_state_path, {
    version: '1.0',
    issued,
    consumed
  });
  result.revoked_count = revoked;
  return result;
}

function normalizeScope(scopeRaw: unknown) {
  const raw = clean(scopeRaw || 'all', 240).toLowerCase();
  if (!raw) return 'all';
  const rows = raw.split(',').map((s) => clean(s, 40).toLowerCase()).filter(Boolean);
  return rows.length ? rows.join(',') : 'all';
}

function openSecurePurgeWindow(policy: AnyObj, state: AnyObj, commandPayload: AnyObj) {
  const req = commandPayload && commandPayload.secure_purge && typeof commandPayload.secure_purge === 'object'
    ? commandPayload.secure_purge
    : {};
  if (!(policy.secure_purge.enabled && req.requested === true)) return { opened: false, pending: null };
  const approvalA = clean(req.approval_a || '', 160);
  const approvalB = clean(req.approval_b || '', 160);
  if (!approvalA || !approvalB || approvalA === approvalB) {
    return {
      opened: false,
      error: 'secure_purge_dual_approval_invalid'
    };
  }
  const windowMinutes = clampInt(
    req.window_minutes,
    1,
    Number(policy.secure_purge.window_minutes_max || 60),
    Number(policy.secure_purge.window_minutes_default || 15)
  );
  const pendingId = `purge_${sha16(`${commandPayload.command_id}|${commandPayload.nonce}|${nowIso()}`)}`;
  const pending = {
    pending_id: pendingId,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + windowMinutes * 60 * 1000).toISOString(),
    command_id: clean(commandPayload.command_id || '', 120) || null,
    approval_a: approvalA,
    approval_b: approvalB,
    confirm_phrase: clean(policy.secure_purge.confirm_phrase || '', 240),
    allow_live_purge: policy.secure_purge.allow_live_purge === true
  };
  state.pending_purge = pending;
  return { opened: true, pending };
}

function performSecurePurge(policy: AnyObj, state: AnyObj, commandPayload: AnyObj) {
  const pending = state && state.pending_purge && typeof state.pending_purge === 'object'
    ? state.pending_purge
    : null;
  if (!pending) return { ok: false, reason: 'secure_purge_pending_missing' };
  const now = Date.now();
  const exp = Date.parse(String(pending.expires_at || ''));
  if (!Number.isFinite(exp) || exp < now) {
    state.pending_purge = null;
    return { ok: false, reason: 'secure_purge_window_expired' };
  }
  const purge = commandPayload && commandPayload.purge && typeof commandPayload.purge === 'object'
    ? commandPayload.purge
    : {};
  const pendingId = clean(purge.pending_id || '', 120);
  if (!pendingId || pendingId !== clean(pending.pending_id || '', 120)) {
    return { ok: false, reason: 'secure_purge_pending_id_mismatch' };
  }
  const approvalA = clean(purge.approval_a || '', 160);
  const approvalB = clean(purge.approval_b || '', 160);
  if (approvalA !== clean(pending.approval_a || '', 160) || approvalB !== clean(pending.approval_b || '', 160)) {
    return { ok: false, reason: 'secure_purge_dual_approval_mismatch' };
  }
  const confirmation = clean(purge.human_confirmation || '', 320);
  if (confirmation !== clean(policy.secure_purge.confirm_phrase || '', 320)) {
    return { ok: false, reason: 'secure_purge_confirmation_missing' };
  }
  const quarantineRoot = path.join(
    policy.secure_purge.quarantine_dir,
    nowIso().slice(0, 10),
    clean(pending.pending_id || '', 120) || `purge_${sha16(nowIso())}`
  );
  const moved: string[] = [];
  const missing: string[] = [];
  const sensitive = Array.isArray(policy.secure_purge.sensitive_paths) ? policy.secure_purge.sensitive_paths : [];
  if (policy.secure_purge.allow_live_purge === true) {
    for (const item of sensitive) {
      const srcPath = resolvePath(item, '');
      if (!srcPath || !fs.existsSync(srcPath)) {
        missing.push(relPath(srcPath || String(item || '')));
        continue;
      }
      const rel = path.isAbsolute(srcPath) && srcPath.startsWith(ROOT)
        ? path.relative(ROOT, srcPath)
        : path.basename(srcPath);
      const destPath = path.join(quarantineRoot, rel);
      ensureDir(path.dirname(destPath));
      fs.renameSync(srcPath, destPath);
      moved.push(relPath(destPath));
    }
  }
  state.pending_purge = null;
  return {
    ok: true,
    pending_id: pending.pending_id,
    live_purge: policy.secure_purge.allow_live_purge === true,
    moved_count: moved.length,
    moved_paths: moved,
    missing_paths: missing,
    quarantine_root: relPath(quarantineRoot)
  };
}

function signCommand(payload: AnyObj, key: string) {
  return {
    ...payload,
    signature: hmacHex(payload, key)
  };
}

function buildSignedCommand(policy: AnyObj, cmd: 'halt' | 'purge', args: AnyObj) {
  const keyInfo = resolveKey(policy);
  if (!keyInfo.key) return { ok: false, reason: 'signing_key_missing', key_env: keyInfo.env_name };
  const now = Date.now();
  const ttlSec = clampInt(args['ttl-sec'] || args.ttl_sec, 10, policy.max_ttl_seconds, Math.min(120, policy.max_ttl_seconds));
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlSec * 1000).toISOString();
  const payload: AnyObj = {
    type: 'remote_emergency_halt_command',
    schema_version: '1.0',
    command: cmd,
    command_id: clean(args['command-id'] || args.command_id || `cmd_${sha16(`${cmd}|${issuedAt}|${Math.random()}`)}`, 120),
    nonce: clean(args.nonce || `nonce_${crypto.randomBytes(12).toString('hex')}`, 120),
    issued_at: issuedAt,
    expires_at: expiresAt,
    actor: clean(args.actor || process.env.USER || 'remote_operator', 120),
    scope: normalizeScope(args.scope || 'all'),
    reason: clean(args.reason || `remote_${cmd}`, 240) || `remote_${cmd}`,
    approval_note: clean(args['approval-note'] || args.approval_note || '', 320),
    policy_root_lease_token: clean(args['lease-token'] || args.lease_token || '', 8192) || null,
    revoke_leases: toBool(args['revoke-leases'], true)
  };
  if (cmd === 'halt') {
    payload.secure_purge = {
      requested: toBool(args['secure-purge'], false),
      window_minutes: clampInt(args['window-minutes'] || args.window_minutes, 1, policy.secure_purge.window_minutes_max, policy.secure_purge.window_minutes_default),
      approval_a: clean(args['approval-a'] || args.approval_a || '', 160),
      approval_b: clean(args['approval-b'] || args.approval_b || '', 160),
      human_confirmation: clean(args['human-confirmation'] || args.human_confirmation || '', 320)
    };
  } else {
    payload.purge = {
      pending_id: clean(args['pending-id'] || args.pending_id || '', 120),
      approval_a: clean(args['approval-a'] || args.approval_a || '', 160),
      approval_b: clean(args['approval-b'] || args.approval_b || '', 160),
      human_confirmation: clean(args['human-confirmation'] || args.human_confirmation || '', 320)
    };
  }
  const signed = signCommand(payload, keyInfo.key);
  return {
    ok: true,
    command: signed,
    command_b64: encodeB64(signed),
    key_env: keyInfo.env_name
  };
}

function parseIncomingCommand(args: AnyObj) {
  if (args['command-b64']) return decodeB64(args['command-b64']);
  if (args.command_b64) return decodeB64(args.command_b64);
  if (args.command) return parseJsonPayload(args.command);
  return null;
}

function cmdStatus(policy: AnyObj) {
  const state = loadState(policy);
  const store = pruneNonces(policy, loadNonceStore(policy));
  saveNonceStore(policy, store);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'remote_emergency_halt_status',
    ts: nowIso(),
    policy_version: policy.version,
    enabled: policy.enabled === true,
    pending_purge: state.pending_purge || null,
    seen_nonces: Object.keys(store.nonces || {}).length,
    paths: {
      state: relPath(policy.paths.state),
      nonce_store: relPath(policy.paths.nonce_store),
      audit: relPath(policy.paths.audit)
    }
  })}\n`);
}

function cmdSign(policy: AnyObj, args: AnyObj, cmd: 'halt' | 'purge') {
  const signed = buildSignedCommand(policy, cmd, args);
  if (!signed.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: signed.reason, key_env: signed.key_env || null })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: cmd === 'halt' ? 'remote_emergency_halt_signed' : 'remote_emergency_purge_signed',
    ts: nowIso(),
    command: signed.command,
    command_b64: signed.command_b64,
    key_env: signed.key_env
  })}\n`);
}

function reject(policy: AnyObj, reason: string, details: AnyObj = {}, strict = false) {
  const payload = {
    ok: false,
    type: 'remote_emergency_halt_receive',
    ts: nowIso(),
    accepted: false,
    reason: clean(reason || 'rejected', 180) || 'rejected',
    ...details
  };
  appendJsonl(policy.paths.audit, {
    ts: payload.ts,
    type: 'remote_emergency_halt_reject',
    reason: payload.reason,
    details
  });
  appendBlackBox(policy, {
    boundary: 'remote_emergency_halt',
    signer: 'local_root',
    ok: false,
    reason: payload.reason,
    chain_hash: sha16(stableStringify(payload))
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict || true) process.exit(1);
}

function cmdReceive(policy: AnyObj, args: AnyObj) {
  const strict = toBool(args.strict, false);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'remote_emergency_halt_receive',
      ts: nowIso(),
      accepted: false,
      reason: 'remote_halt_disabled'
    })}\n`);
    process.exit(strict ? 1 : 0);
  }

  const signed = parseIncomingCommand(args);
  if (!signed || typeof signed !== 'object') {
    return reject(policy, 'command_missing_or_invalid', {}, strict);
  }

  const verified = verifySignedCommand(policy, signed);
  if (!verified.ok) {
    return reject(policy, verified.reason || 'verify_failed', verified, strict);
  }
  const payload = verified.payload;
  const command = clean(payload.command || '', 24).toLowerCase();
  if (command !== 'halt' && command !== 'purge') {
    return reject(policy, 'command_unsupported', { command }, strict);
  }

  const policyRoot = authorizePolicyRoot(policy, payload);
  if (!policyRoot.ok) {
    return reject(policy, policyRoot.reason || 'policy_root_denied', { policy_root: policyRoot }, strict);
  }

  const state = loadState(policy);
  let output: AnyObj = {
    ok: true,
    type: 'remote_emergency_halt_receive',
    ts: nowIso(),
    accepted: true,
    command,
    command_id: clean(payload.command_id || '', 120) || null,
    nonce: clean(payload.nonce || '', 120) || null,
    policy_root: policyRoot.decision || { ok: true, skipped: true }
  };

  if (command === 'halt') {
    const approvalNote = clean(payload.approval_note || '', 320);
    const scope = normalizeScope(payload.scope || 'all');
    const emergencyState = engageEmergencyStop({
      scopes: scope,
      approval_note: approvalNote || 'remote_signed_halt',
      actor: clean(payload.actor || 'remote_operator', 120) || 'remote_operator',
      reason: clean(payload.reason || 'remote_signed_halt', 240) || 'remote_signed_halt'
    });
    const leaseRevocation = payload.revoke_leases === false
      ? {
          attempted: false,
          revoked_count: 0,
          lease_state_path: relPath(policy.revoke_leases.lease_state_path),
          lease_audit_path: relPath(policy.revoke_leases.lease_audit_path)
        }
      : revokeActiveLeases(policy, clean(payload.command_id || '', 120));
    const purgeWindow = openSecurePurgeWindow(policy, state, payload);
    state.last_halt = {
      ts: nowIso(),
      command_id: clean(payload.command_id || '', 120) || null,
      reason: clean(payload.reason || '', 240) || null,
      scope
    };
    saveState(policy, state);
    output = {
      ...output,
      emergency_stop: emergencyState,
      leases: leaseRevocation,
      secure_purge: purgeWindow.opened
        ? {
            pending: true,
            pending_id: purgeWindow.pending.pending_id,
            expires_at: purgeWindow.pending.expires_at,
            allow_live_purge: purgeWindow.pending.allow_live_purge === true
          }
        : purgeWindow.error
          ? {
              pending: false,
              error: purgeWindow.error
            }
          : {
              pending: false
            }
    };
    appendJsonl(policy.paths.audit, {
      ts: output.ts,
      type: 'remote_emergency_halt_accept',
      command: 'halt',
      command_id: output.command_id,
      nonce: output.nonce,
      scope,
      revoked_leases: Number(leaseRevocation.revoked_count || 0),
      secure_purge_pending: !!(output.secure_purge && output.secure_purge.pending === true)
    });
  } else {
    const purgeResult = performSecurePurge(policy, state, payload);
    if (!purgeResult.ok) {
      saveState(policy, state);
      return reject(policy, purgeResult.reason || 'secure_purge_failed', { command_id: output.command_id }, strict);
    }
    saveState(policy, state);
    output = {
      ...output,
      secure_purge: purgeResult
    };
    appendJsonl(policy.paths.audit, {
      ts: output.ts,
      type: 'remote_emergency_purge_accept',
      command: 'purge',
      command_id: output.command_id,
      nonce: output.nonce,
      pending_id: purgeResult.pending_id || null,
      moved_count: Number(purgeResult.moved_count || 0),
      live_purge: purgeResult.live_purge === true
    });
  }

  appendBlackBox(policy, {
    boundary: command === 'halt' ? 'remote_emergency_halt' : 'remote_emergency_purge',
    signer: 'local_root',
    ok: true,
    command,
    command_id: output.command_id || null,
    nonce: output.nonce || null,
    chain_hash: sha16(stableStringify(output))
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/remote_emergency_halt.js status');
  console.log('  node systems/security/remote_emergency_halt.js sign-halt --approval-note="<text>" [--scope=all] [--ttl-sec=120]');
  console.log('  node systems/security/remote_emergency_halt.js sign-purge --pending-id=<id> --approval-a=<id> --approval-b=<id> --human-confirmation="<phrase>" [--ttl-sec=120]');
  console.log('  node systems/security/remote_emergency_halt.js receive --command="<json>"');
  console.log('  node systems/security/remote_emergency_halt.js receive-b64 --command-b64="<base64>"');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'status', 40).toLowerCase();
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (cmd === 'status') return cmdStatus(policy);
  if (cmd === 'sign-halt') return cmdSign(policy, args, 'halt');
  if (cmd === 'sign-purge') return cmdSign(policy, args, 'purge');
  if (cmd === 'receive' || cmd === 'receive-b64') return cmdReceive(policy, args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'remote_emergency_halt',
      error: clean(err && err.message ? err.message : err || 'remote_emergency_halt_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

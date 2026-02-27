#!/usr/bin/env node
'use strict';
export {};

/**
 * agent_passport.js
 *
 * V2-063:
 * - Cryptographic action passport with actor/role/tenant/model/framework/org binding.
 * - Signed, hash-chained JSON action stream for forensic chain of custody.
 * - Deterministic PDF export generated from canonical JSON source-of-truth.
 *
 * Usage:
 *   node systems/security/agent_passport.js issue --actor=<id> [--role=<role>] [--tenant=<tenant>] [--model=<model>] [--framework=<fw>] [--org=<org>] [--ttl-hours=<n>]
 *   node systems/security/agent_passport.js append --action-json='{"action_type":"x"}'
 *   node systems/security/agent_passport.js verify [--strict=1]
 *   node systems/security/agent_passport.js export-pdf [--out=<abs|rel>] [--max-rows=<n>]
 *   node systems/security/agent_passport.js status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.AGENT_PASSPORT_POLICY_PATH
  ? path.resolve(process.env.AGENT_PASSPORT_POLICY_PATH)
  : path.join(ROOT, 'config', 'agent_passport_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 512);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shaHex(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function hmacHex(value: unknown, key: string) {
  return crypto.createHmac('sha256', String(key || '')).update(stableStringify(value), 'utf8').digest('hex');
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    auto_link_from_receipts: true,
    auto_issue_passport: true,
    require_active_passport: false,
    passport_ttl_hours: 24 * 7,
    key_env: 'AGENT_PASSPORT_SIGNING_KEY',
    actor_defaults: {
      actor_id: 'local_operator',
      role: 'system',
      tenant_id: 'local',
      org_id: 'protheus',
      framework_id: 'openclaw',
      model_id: 'unknown'
    },
    state: {
      root: 'state/security/agent_passport',
      passport_path: 'state/security/agent_passport/passport.json',
      action_log_path: 'state/security/agent_passport/actions.jsonl',
      chain_state_path: 'state/security/agent_passport/actions.chain.json',
      latest_path: 'state/security/agent_passport/latest.json',
      receipts_path: 'state/security/agent_passport/receipts.jsonl'
    },
    pdf: {
      default_out_path: 'state/security/agent_passport/exports/latest_passport.pdf',
      max_rows: 2000
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const actor = src.actor_defaults && typeof src.actor_defaults === 'object'
    ? src.actor_defaults
    : {};
  const state = src.state && typeof src.state === 'object'
    ? src.state
    : {};
  const pdf = src.pdf && typeof src.pdf === 'object'
    ? src.pdf
    : {};
  return {
    version: cleanText(src.version || base.version, 24) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    auto_link_from_receipts: src.auto_link_from_receipts !== false,
    auto_issue_passport: src.auto_issue_passport !== false,
    require_active_passport: toBool(src.require_active_passport, base.require_active_passport),
    passport_ttl_hours: clampInt(src.passport_ttl_hours, 1, 24 * 3650, base.passport_ttl_hours),
    key_env: cleanText(src.key_env || base.key_env, 80) || base.key_env,
    actor_defaults: {
      actor_id: normalizeToken(actor.actor_id || base.actor_defaults.actor_id, 120) || base.actor_defaults.actor_id,
      role: normalizeToken(actor.role || base.actor_defaults.role, 80) || base.actor_defaults.role,
      tenant_id: normalizeToken(actor.tenant_id || base.actor_defaults.tenant_id, 120) || base.actor_defaults.tenant_id,
      org_id: normalizeToken(actor.org_id || base.actor_defaults.org_id, 120) || base.actor_defaults.org_id,
      framework_id: normalizeToken(actor.framework_id || base.actor_defaults.framework_id, 120) || base.actor_defaults.framework_id,
      model_id: normalizeToken(actor.model_id || base.actor_defaults.model_id, 120) || base.actor_defaults.model_id
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      passport_path: resolvePath(state.passport_path || base.state.passport_path, base.state.passport_path),
      action_log_path: resolvePath(state.action_log_path || base.state.action_log_path, base.state.action_log_path),
      chain_state_path: resolvePath(state.chain_state_path || base.state.chain_state_path, base.state.chain_state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    pdf: {
      default_out_path: resolvePath(pdf.default_out_path || base.pdf.default_out_path, base.pdf.default_out_path),
      max_rows: clampInt(pdf.max_rows, 1, 100000, base.pdf.max_rows)
    }
  };
}

function resolveSigningKey(policy: AnyObj) {
  const envName = cleanText(policy && policy.key_env || '', 80) || 'AGENT_PASSPORT_SIGNING_KEY';
  const key = cleanText(process.env[envName] || '', 4096);
  return { env_name: envName, key };
}

function readIdentityDigest() {
  const identityPath = path.join(ROOT, 'IDENTITY.md');
  try {
    if (!fs.existsSync(identityPath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(identityPath)).digest('hex');
  } catch {
    return null;
  }
}

function readChainState(policy: AnyObj) {
  const src = readJson(policy.state.chain_state_path, null);
  if (!src || typeof src !== 'object') return { seq: 0, hash: null };
  const seq = Number(src.seq || 0);
  const hash = typeof src.hash === 'string' ? src.hash : null;
  return {
    seq: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0,
    hash
  };
}

function writeChainState(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.chain_state_path, {
    seq: Number(row && row.seq || 0),
    hash: row && row.hash ? String(row.hash) : null,
    ts: nowIso()
  });
}

function buildActorContext(policy: AnyObj, args: AnyObj = {}) {
  const d = policy.actor_defaults || {};
  return {
    actor_id: normalizeToken(args.actor || args['actor-id'] || d.actor_id || 'local_operator', 120) || 'local_operator',
    role: normalizeToken(args.role || d.role || 'system', 80) || 'system',
    tenant_id: normalizeToken(args.tenant || args['tenant-id'] || d.tenant_id || 'local', 120) || 'local',
    org_id: normalizeToken(args.org || args['org-id'] || d.org_id || 'protheus', 120) || 'protheus',
    framework_id: normalizeToken(args.framework || args['framework-id'] || d.framework_id || 'openclaw', 120) || 'openclaw',
    model_id: normalizeToken(args.model || args['model-id'] || d.model_id || 'unknown', 120) || 'unknown'
  };
}

function readPassport(policy: AnyObj) {
  return readJson(policy.state.passport_path, null);
}

function passportIsActive(passport: AnyObj) {
  if (!passport || typeof passport !== 'object') return false;
  const exp = parseIsoMs(passport.expires_at);
  return Number.isFinite(exp) && exp > Date.now();
}

function signPayload(payload: AnyObj, policy: AnyObj) {
  const keyInfo = resolveSigningKey(policy);
  if (!keyInfo.key) return { ok: false, reason: 'signing_key_missing', key_env: keyInfo.env_name };
  return {
    ok: true,
    key_env: keyInfo.env_name,
    signature: hmacHex(payload, keyInfo.key)
  };
}

function issuePassport(args: AnyObj = {}, opts: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/agent_passport_policy.json');
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'agent_passport_issue', error: 'policy_disabled' };
  }
  const actor = buildActorContext(policy, args);
  const ttlHours = clampInt(
    args['ttl-hours'] || args.ttl_hours || args.ttl || policy.passport_ttl_hours,
    1,
    24 * 3650,
    policy.passport_ttl_hours
  );
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();
  const passportId = `passport_${crypto.createHash('sha256')
    .update(`${actor.actor_id}|${actor.tenant_id}|${issuedAt}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const payload = {
    schema_id: 'agent_passport',
    schema_version: '1.0',
    passport_id: passportId,
    issued_at: issuedAt,
    expires_at: expiresAt,
    actor,
    identity_anchor_digest: readIdentityDigest(),
    host: cleanText(os.hostname(), 120),
    auto_issued: opts.auto_issued === true
  };
  const signed = signPayload(payload, policy);
  if (!signed.ok) {
    return {
      ok: false,
      type: 'agent_passport_issue',
      error: signed.reason,
      key_env: signed.key_env
    };
  }
  const doc = {
    ...payload,
    signature: {
      algo: 'hmac-sha256',
      key_env: signed.key_env,
      value: signed.signature
    }
  };
  if (policy.shadow_only !== true && opts.apply !== false) {
    writeJsonAtomic(policy.state.passport_path, doc);
  }
  appendJsonl(policy.state.receipts_path, {
    ts: issuedAt,
    type: 'agent_passport_issue',
    ok: true,
    auto_issued: opts.auto_issued === true,
    passport_id: passportId,
    actor_id: actor.actor_id,
    tenant_id: actor.tenant_id,
    org_id: actor.org_id,
    framework_id: actor.framework_id,
    model_id: actor.model_id,
    ttl_hours: ttlHours,
    policy_path: relPath(policyPath)
  });
  writeJsonAtomic(policy.state.latest_path, {
    ok: true,
    type: 'agent_passport_issue',
    ts: issuedAt,
    passport_id: passportId,
    actor_id: actor.actor_id,
    tenant_id: actor.tenant_id,
    shadow_only: policy.shadow_only === true
  });
  return {
    ok: true,
    type: 'agent_passport_issue',
    ts: issuedAt,
    passport_id: passportId,
    actor_id: actor.actor_id,
    tenant_id: actor.tenant_id,
    org_id: actor.org_id,
    framework_id: actor.framework_id,
    model_id: actor.model_id,
    expires_at: expiresAt,
    shadow_only: policy.shadow_only === true
  };
}

function ensureActivePassport(policy: AnyObj, args: AnyObj = {}) {
  const active = readPassport(policy);
  if (passportIsActive(active)) return { ok: true, passport: active };
  if (policy.require_active_passport === true && policy.auto_issue_passport !== true) {
    return { ok: false, reason: 'active_passport_required' };
  }
  if (policy.auto_issue_passport !== true) {
    return { ok: false, reason: 'active_passport_missing' };
  }
  const issued = issuePassport(args, { auto_issued: true, apply: true });
  if (!issued.ok) return { ok: false, reason: issued.error || 'auto_issue_failed' };
  const next = readPassport(policy);
  if (!passportIsActive(next)) return { ok: false, reason: 'auto_issue_inactive' };
  return { ok: true, passport: next };
}

function parseActionInput(args: AnyObj) {
  const raw = cleanText(args['action-json'] || args.action_json || '', 20000);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeAction(payload: AnyObj = {}) {
  return {
    action_type: normalizeToken(payload.action_type || payload.type || 'action', 120) || 'action',
    objective_id: normalizeToken(payload.objective_id || '', 180) || null,
    target: cleanText(payload.target || payload.receipt_path || payload.objective || payload.summary || '', 240) || null,
    status: normalizeToken(payload.status || '', 60) || null,
    attempted: payload.attempted === true,
    verified: payload.verified === true,
    receipt_path: cleanText(payload.receipt_path || '', 280) || null,
    receipt_id: normalizeToken(payload.receipt_id || '', 180) || null,
    receipt_seq: clampInt(payload.receipt_seq, 0, 1_000_000_000, 0) || null,
    receipt_hash: cleanText(payload.receipt_hash || '', 80) || null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  };
}

function appendAction(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/agent_passport_policy.json');
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'agent_passport_append', error: 'policy_disabled' };
  }
  if (policy.auto_link_from_receipts !== true && args.source === 'receipt_link') {
    return { ok: true, type: 'agent_passport_append', skipped: true, reason: 'auto_link_disabled' };
  }
  const passportRes = ensureActivePassport(policy, args);
  if (!passportRes.ok) {
    return { ok: false, type: 'agent_passport_append', error: passportRes.reason };
  }
  const passport = passportRes.passport;
  const actionInput = args.action && typeof args.action === 'object'
    ? args.action
    : parseActionInput(args);
  const action = normalizeAction(actionInput);
  const chain = readChainState(policy);
  const seq = Number(chain.seq || 0) + 1;
  const prevHash = chain.hash || null;
  const actionId = `apx_${crypto.createHash('sha256')
    .update(`${passport.passport_id}|${seq}|${nowIso()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const base = {
    schema_id: 'agent_passport_action',
    schema_version: '1.0',
    ts: nowIso(),
    action_id: actionId,
    passport_id: cleanText(passport.passport_id || '', 120),
    actor: passport.actor,
    runtime: {
      framework_id: cleanText(passport.actor && passport.actor.framework_id || '', 120) || null,
      model_id: cleanText(passport.actor && passport.actor.model_id || '', 120) || null,
      host: cleanText(os.hostname(), 120),
      pid: process.pid
    },
    source: normalizeToken(args.source || 'manual', 80) || 'manual',
    action
  };
  const payloadHash = shaHex(base);
  const linkHash = shaHex({
    seq,
    prev_hash: prevHash,
    payload_hash: payloadHash
  });
  const signed = signPayload({ link_hash: linkHash, passport_id: base.passport_id, actor: base.actor }, policy);
  if (!signed.ok) {
    return {
      ok: false,
      type: 'agent_passport_append',
      error: signed.reason,
      key_env: signed.key_env
    };
  }
  const row = {
    ...base,
    integrity: {
      version: '1.0',
      seq,
      prev_hash: prevHash,
      payload_hash: payloadHash,
      hash: linkHash
    },
    signature: {
      algo: 'hmac-sha256',
      key_env: signed.key_env,
      value: signed.signature
    }
  };
  if (policy.shadow_only !== true) {
    appendJsonl(policy.state.action_log_path, row);
    writeChainState(policy, { seq, hash: linkHash });
  }
  appendJsonl(policy.state.receipts_path, {
    ts: row.ts,
    type: 'agent_passport_append',
    ok: true,
    action_id: actionId,
    seq,
    passport_id: row.passport_id,
    action_type: row.action.action_type,
    policy_path: relPath(policyPath),
    shadow_only: policy.shadow_only === true,
    source: row.source
  });
  writeJsonAtomic(policy.state.latest_path, {
    ok: true,
    type: 'agent_passport_append',
    ts: row.ts,
    action_id: actionId,
    seq,
    passport_id: row.passport_id,
    action_type: row.action.action_type,
    shadow_only: policy.shadow_only === true
  });
  return {
    ok: true,
    type: 'agent_passport_append',
    action_id: actionId,
    seq,
    hash: linkHash,
    passport_id: row.passport_id,
    action_type: row.action.action_type,
    shadow_only: policy.shadow_only === true
  };
}

function appendActionFromReceipt(input: AnyObj = {}) {
  const rec = input && input.receipt_record && typeof input.receipt_record === 'object'
    ? input.receipt_record
    : {};
  const contract = rec.receipt_contract && typeof rec.receipt_contract === 'object'
    ? rec.receipt_contract
    : {};
  const integrity = contract.integrity && typeof contract.integrity === 'object'
    ? contract.integrity
    : {};
  const action = {
    action_type: normalizeToken(rec.type || 'receipt', 120) || 'receipt',
    objective_id: normalizeToken(rec.objective_id || rec.proposal_id || '', 180) || null,
    target: cleanText(
      rec.objective
      || rec.summary
      || rec.action
      || rec.id
      || rec.proposal_id
      || '',
      240
    ) || null,
    status: normalizeToken(rec.status || (rec.ok === true ? 'ok' : ''), 60) || null,
    attempted: contract.attempted === true,
    verified: contract.verified === true,
    receipt_path: cleanText(input.receipt_path || '', 280) || null,
    receipt_id: normalizeToken(rec.receipt_id || '', 180) || null,
    receipt_seq: Number(integrity.seq || 0) || null,
    receipt_hash: cleanText(integrity.hash || '', 80) || null,
    metadata: {
      lane: cleanText(rec.lane || '', 80) || null
    }
  };
  return appendAction({
    source: 'receipt_link',
    action,
    policy: input.policy
  });
}

function verifyActionChain(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/agent_passport_policy.json');
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const rows = readJsonl(policy.state.action_log_path);
  const keyInfo = resolveSigningKey(policy);
  let prevHash = null;
  let ok = true;
  let signatureOk = 0;
  const errors: AnyObj[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const seq = Number(row && row.integrity && row.integrity.seq || 0);
    const integrity = row.integrity && typeof row.integrity === 'object' ? row.integrity : {};
    const clone = { ...row };
    delete clone.integrity;
    delete clone.signature;
    const payloadHash = shaHex(clone);
    const expectedHash = shaHex({
      seq,
      prev_hash: prevHash,
      payload_hash: payloadHash
    });
    if (payloadHash !== integrity.payload_hash) {
      ok = false;
      errors.push({ index: i, reason: 'payload_hash_mismatch', seq });
    }
    if (String(integrity.hash || '') !== expectedHash) {
      ok = false;
      errors.push({ index: i, reason: 'chain_hash_mismatch', seq });
    }
    if (String(integrity.prev_hash || '') !== String(prevHash || '')) {
      ok = false;
      errors.push({ index: i, reason: 'prev_hash_mismatch', seq });
    }
    if (keyInfo.key) {
      const sig = row.signature && typeof row.signature === 'object' ? row.signature : {};
      const expectedSig = hmacHex(
        {
          link_hash: expectedHash,
          passport_id: cleanText(row.passport_id || '', 120),
          actor: row.actor
        },
        keyInfo.key
      );
      if (String(sig.value || '') !== expectedSig) {
        ok = false;
        errors.push({ index: i, reason: 'signature_mismatch', seq });
      } else {
        signatureOk += 1;
      }
    }
    prevHash = String(integrity.hash || '');
  }
  const out = {
    ok,
    type: 'agent_passport_verify',
    ts: nowIso(),
    strict,
    rows: rows.length,
    signature_rows_verified: signatureOk,
    key_present: !!keyInfo.key,
    key_env: keyInfo.env_name,
    errors: errors.slice(0, 200),
    policy_path: relPath(policyPath)
  };
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function escapePdfText(line: string) {
  return String(line || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildDeterministicPdf(lines: string[]) {
  const safeLines = (Array.isArray(lines) ? lines : [])
    .map((line) => cleanText(line, 180))
    .filter(Boolean)
    .slice(0, 56);
  const content = [
    'BT',
    '/F1 10 Tf',
    '50 770 Td',
    '13 TL',
    ...safeLines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, 'T*']),
    'ET'
  ].join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream\nendobj\n`
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += obj;
  }
  const xrefOffset = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

function exportPassportPdf(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/agent_passport_policy.json');
  const policy = loadPolicy(policyPath);
  const rows = readJsonl(policy.state.action_log_path);
  const passport = readPassport(policy);
  const maxRows = clampInt(args['max-rows'] || args.max_rows, 1, 100000, policy.pdf.max_rows);
  const sample = rows.slice(-maxRows);
  const canonical = {
    schema_id: 'agent_passport_export',
    schema_version: '1.0',
    generated_from: relPath(policy.state.action_log_path),
    passport_id: cleanText(passport && passport.passport_id || '', 120) || null,
    actor: passport && passport.actor ? passport.actor : null,
    total_actions: rows.length,
    sample_rows: sample.map((row: AnyObj) => ({
      seq: Number(row && row.integrity && row.integrity.seq || 0),
      ts: cleanText(row && row.ts || '', 64),
      action_type: cleanText(row && row.action && row.action.action_type || '', 80),
      target: cleanText(row && row.action && row.action.target || '', 160) || null,
      status: cleanText(row && row.action && row.action.status || '', 60) || null,
      hash: cleanText(row && row.integrity && row.integrity.hash || '', 80)
    }))
  };
  const canonicalHash = shaHex(canonical);
  const lines = [
    'Protheus Agent Passport Report',
    `Canonical Hash: ${canonicalHash}`,
    `Generated From: ${canonical.generated_from}`,
    `Passport ID: ${canonical.passport_id || 'none'}`,
    `Actor: ${cleanText(canonical.actor && canonical.actor.actor_id || 'unknown', 80)}`,
    `Tenant: ${cleanText(canonical.actor && canonical.actor.tenant_id || 'unknown', 80)}`,
    `Org: ${cleanText(canonical.actor && canonical.actor.org_id || 'unknown', 80)}`,
    `Model: ${cleanText(canonical.actor && canonical.actor.model_id || 'unknown', 80)}`,
    `Framework: ${cleanText(canonical.actor && canonical.actor.framework_id || 'unknown', 80)}`,
    `Total actions: ${rows.length}`,
    `Included rows: ${canonical.sample_rows.length}`,
    ''
  ];
  for (const row of canonical.sample_rows.slice(0, 40)) {
    lines.push(
      `${String(row.seq).padStart(4, ' ')} | ${cleanText(row.ts, 24)} | ${cleanText(row.action_type, 24)} | ${cleanText(row.status || '-', 10)} | ${cleanText(row.target || '-', 72)}`
    );
  }
  const pdfBuffer = buildDeterministicPdf(lines);
  const outPath = resolvePath(args.out || policy.pdf.default_out_path, 'state/security/agent_passport/exports/latest_passport.pdf');
  if (policy.shadow_only !== true) {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, pdfBuffer);
    const jsonPath = outPath.replace(/\.pdf$/i, '.json');
    writeJsonAtomic(jsonPath, { ...canonical, canonical_hash: canonicalHash });
  }
  const out = {
    ok: true,
    type: 'agent_passport_export_pdf',
    ts: nowIso(),
    out_path: relPath(outPath),
    canonical_hash: canonicalHash,
    rows_exported: canonical.sample_rows.length,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.state.receipts_path, out);
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/agent_passport_policy.json');
  const policy = loadPolicy(policyPath);
  const passport = readPassport(policy);
  const chain = readChainState(policy);
  const rows = readJsonl(policy.state.action_log_path);
  return {
    ok: true,
    type: 'agent_passport_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      auto_link_from_receipts: policy.auto_link_from_receipts === true
    },
    passport: passport && typeof passport === 'object'
      ? {
        passport_id: passport.passport_id || null,
        actor_id: passport.actor && passport.actor.actor_id || null,
        tenant_id: passport.actor && passport.actor.tenant_id || null,
        expires_at: passport.expires_at || null,
        active: passportIsActive(passport)
      }
      : null,
    chain: {
      seq: Number(chain.seq || 0),
      hash: chain.hash || null
    },
    actions_count: rows.length,
    paths: {
      passport_path: relPath(policy.state.passport_path),
      action_log_path: relPath(policy.state.action_log_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/agent_passport.js issue --actor=<id> [--role=<role>] [--tenant=<tenant>] [--model=<model>] [--framework=<fw>] [--org=<org>] [--ttl-hours=<n>]');
  console.log('  node systems/security/agent_passport.js append --action-json=\'{"action_type":"x"}\'');
  console.log('  node systems/security/agent_passport.js verify [--strict=1]');
  console.log('  node systems/security/agent_passport.js export-pdf [--out=<path>] [--max-rows=<n>]');
  console.log('  node systems/security/agent_passport.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'issue') out = issuePassport(args, { apply: true });
  else if (cmd === 'append') out = appendAction(args);
  else if (cmd === 'verify') out = verifyActionChain(args);
  else if (cmd === 'export-pdf') out = exportPassportPdf(args);
  else if (cmd === 'status') out = status(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  issuePassport,
  appendAction,
  appendActionFromReceipt,
  verifyActionChain,
  exportPassportPdf,
  status
};


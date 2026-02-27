#!/usr/bin/env node
'use strict';
export {};

/**
 * alias_verification_vault.js
 *
 * V2-066:
 * - Policy-gated temporary alias issuance for email/SMS verification lanes.
 * - Encrypted verification-code routing + consume/revoke lifecycle.
 * - Immutable audit receipts with optional passport linkage.
 *
 * Usage:
 *   node systems/security/alias_verification_vault.js issue --channel=email|sms [--purpose=<txt>] [--ttl-hours=<n>] [--passport-id=<id>] [--apply=1|0]
 *   node systems/security/alias_verification_vault.js route-code --alias-id=<id> --code=<txt> [--source=<txt>] [--passport-id=<id>] [--apply=1|0]
 *   node systems/security/alias_verification_vault.js consume-code --alias-id=<id> [--peek=1|0] [--reveal=1|0] [--apply=1|0]
 *   node systems/security/alias_verification_vault.js revoke --alias-id=<id> [--reason=<txt>] [--passport-id=<id>] [--apply=1|0]
 *   node systems/security/alias_verification_vault.js cleanup [--apply=1|0]
 *   node systems/security/alias_verification_vault.js status [--alias-id=<id>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ALIAS_VERIFICATION_VAULT_POLICY_PATH
  ? path.resolve(process.env.ALIAS_VERIFICATION_VAULT_POLICY_PATH)
  : path.join(ROOT, 'config', 'alias_verification_vault_policy.json');

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

function cleanText(v: unknown, maxLen = 220) {
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

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
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

function sha16(value: unknown) {
  return shaHex(value).slice(0, 16);
}

function hmacHex(value: unknown, key: string) {
  return crypto.createHmac('sha256', String(key || '')).update(stableStringify(value), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    key_env: 'ALIAS_VERIFICATION_VAULT_KEY',
    key_min_length: 24,
    default_ttl_hours: 72,
    max_aliases: 5000,
    code_ttl_minutes: 30,
    cleanup_retention_hours: 24 * 30,
    channels: {
      email: {
        domain: 'vault.local',
        prefix: 'ax'
      },
      sms: {
        prefix: '+1555000'
      }
    },
    state: {
      root: 'state/security/alias_verification_vault',
      index_path: 'state/security/alias_verification_vault/index.json',
      latest_path: 'state/security/alias_verification_vault/latest.json',
      receipts_path: 'state/security/alias_verification_vault/receipts.jsonl'
    },
    redaction: {
      show_plaintext_codes_by_default: false
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const channels = src.channels && typeof src.channels === 'object' ? src.channels : {};
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  const redaction = src.redaction && typeof src.redaction === 'object' ? src.redaction : {};
  return {
    version: cleanText(src.version || base.version, 32) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    key_env: cleanText(src.key_env || base.key_env, 80) || base.key_env,
    key_min_length: clampInt(src.key_min_length, 8, 4096, base.key_min_length),
    default_ttl_hours: clampInt(src.default_ttl_hours, 1, 24 * 3650, base.default_ttl_hours),
    max_aliases: clampInt(src.max_aliases, 1, 1000000, base.max_aliases),
    code_ttl_minutes: clampInt(src.code_ttl_minutes, 1, 24 * 60, base.code_ttl_minutes),
    cleanup_retention_hours: clampInt(
      src.cleanup_retention_hours,
      1,
      24 * 3650,
      base.cleanup_retention_hours
    ),
    channels: {
      email: {
        domain: cleanText(
          channels.email && channels.email.domain || base.channels.email.domain,
          180
        ) || base.channels.email.domain,
        prefix: normalizeToken(
          channels.email && channels.email.prefix || base.channels.email.prefix,
          32
        ) || base.channels.email.prefix
      },
      sms: {
        prefix: cleanText(
          channels.sms && channels.sms.prefix || base.channels.sms.prefix,
          24
        ) || base.channels.sms.prefix
      }
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      index_path: resolvePath(state.index_path || base.state.index_path, base.state.index_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    redaction: {
      show_plaintext_codes_by_default: redaction.show_plaintext_codes_by_default === true
    }
  };
}

function resolveKey(policy: AnyObj) {
  const envName = cleanText(policy.key_env || '', 80) || 'ALIAS_VERIFICATION_VAULT_KEY';
  const key = String(process.env[envName] || '');
  const minLen = Number(policy.key_min_length || 24);
  if (key.length < minLen) {
    return {
      ok: false,
      env_name: envName,
      error: 'alias_vault_key_missing_or_too_short'
    };
  }
  return {
    ok: true,
    env_name: envName,
    key
  };
}

function deriveKey(secret: string, saltB64: string, iterations = 120000) {
  const salt = Buffer.from(String(saltB64 || ''), 'base64');
  return crypto.pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
}

function encryptCode(code: string, secret: string) {
  const salt = crypto.randomBytes(16).toString('base64');
  const iv = crypto.randomBytes(12).toString('base64');
  const iterations = 120000;
  const key = deriveKey(secret, salt, iterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  const plaintext = Buffer.from(String(code || ''), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'pbkdf2-sha256',
    iterations,
    salt,
    iv,
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    code_hash: shaHex(code)
  };
}

function decryptCode(envelope: AnyObj, secret: string) {
  const key = deriveKey(secret, String(envelope.salt || ''), Number(envelope.iterations || 120000));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv || ''), 'base64'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64')),
    decipher.final()
  ]).toString('utf8');
  if (shaHex(out) !== String(envelope.code_hash || '')) {
    throw new Error('alias_vault_code_hash_mismatch');
  }
  return out;
}

function initIndex() {
  return {
    schema_id: 'alias_verification_vault_index',
    schema_version: '1.0',
    created_at: nowIso(),
    updated_at: nowIso(),
    aliases: []
  };
}

function loadIndex(policy: AnyObj) {
  const idx = readJson(policy.state.index_path, null);
  if (!idx || typeof idx !== 'object') return initIndex();
  const aliases = Array.isArray(idx.aliases) ? idx.aliases : [];
  return {
    ...idx,
    aliases
  };
}

function saveIndex(policy: AnyObj, index: AnyObj, ts: string) {
  const out = {
    ...index,
    updated_at: ts
  };
  writeJsonAtomic(policy.state.index_path, out);
  return out;
}

function isActiveAlias(alias: AnyObj, nowMs: number) {
  if (!alias || typeof alias !== 'object') return false;
  if (String(alias.status || '') !== 'active') return false;
  const expMs = parseIsoMs(alias.expires_at);
  return expMs == null || expMs > nowMs;
}

function redactAddress(channel: string, address: string) {
  const raw = String(address || '');
  if (channel === 'email') {
    const idx = raw.indexOf('@');
    if (idx <= 0) return '***';
    return `${raw.slice(0, 2)}***${raw.slice(idx)}`;
  }
  if (channel === 'sms') {
    return raw.length >= 4 ? `***${raw.slice(-4)}` : '***';
  }
  return '***';
}

function aliasAddress(policy: AnyObj, channel: string, aliasId: string) {
  if (channel === 'email') {
    const prefix = normalizeToken(policy.channels.email.prefix, 24) || 'ax';
    const domain = cleanText(policy.channels.email.domain, 180) || 'vault.local';
    return `${prefix}+${aliasId}@${domain}`;
  }
  if (channel === 'sms') {
    const prefix = cleanText(policy.channels.sms.prefix, 24) || '+1555000';
    const tail = String(parseInt(sha16(aliasId).slice(0, 6), 16) % 1000000).padStart(6, '0');
    return `${prefix}${tail}`;
  }
  return `alias:${aliasId}`;
}

function findAlias(index: AnyObj, aliasId: string) {
  const aliases = Array.isArray(index.aliases) ? index.aliases : [];
  for (const row of aliases) {
    if (String(row && row.alias_id || '') === aliasId) return row;
  }
  return null;
}

function writeReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.state.receipts_path, {
    ts: nowIso(),
    type: 'alias_vault_receipt',
    ...row
  });
}

function commandIssue(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const channel = normalizeToken(args.channel || '', 16);
  if (channel !== 'email' && channel !== 'sms') {
    throw new Error('channel_required_email_or_sms');
  }
  const purpose = cleanText(args.purpose || 'verification', 180) || 'verification';
  const ttlHours = clampInt(args['ttl-hours'] || args.ttl_hours, 1, 24 * 3650, policy.default_ttl_hours);
  const passportId = normalizeToken(args['passport-id'] || args.passport_id || '', 160) || null;
  const apply = toBool(args.apply, policy.shadow_only !== true);

  const index = loadIndex(policy);
  const activeCount = Array.isArray(index.aliases)
    ? index.aliases.filter((row: AnyObj) => String(row && row.status || '') === 'active').length
    : 0;
  if (activeCount >= Number(policy.max_aliases || 5000)) {
    throw new Error('alias_capacity_reached');
  }

  const seed = `${nowTs}|${process.pid}|${Math.random()}|${channel}|${purpose}`;
  const aliasId = `av_${sha16(seed)}`;
  const address = aliasAddress(policy, channel, aliasId);
  const expiresAt = new Date(nowMs + (ttlHours * 60 * 60 * 1000)).toISOString();
  const record = {
    alias_id: aliasId,
    channel,
    address,
    purpose,
    issued_at: nowTs,
    expires_at: expiresAt,
    status: 'active',
    passport_id: passportId,
    codes: []
  };
  if (apply) {
    index.aliases.push(record);
    saveIndex(policy, index, nowTs);
  }
  writeReceipt(policy, {
    action: 'issue',
    ok: true,
    apply,
    alias_id: aliasId,
    channel,
    address_redacted: redactAddress(channel, address),
    passport_id: passportId
  });
  const out = {
    ok: true,
    type: 'alias_vault_issue',
    ts: nowTs,
    apply,
    shadow_only: policy.shadow_only === true,
    alias: {
      alias_id: aliasId,
      channel,
      address,
      purpose,
      expires_at: expiresAt,
      passport_id: passportId
    },
    index_path: relPath(policy.state.index_path),
    receipts_path: relPath(policy.state.receipts_path)
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function commandRouteCode(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const aliasId = normalizeToken(args['alias-id'] || args.alias_id || '', 160);
  const source = cleanText(args.source || 'unknown_source', 160) || 'unknown_source';
  const codeRaw = cleanText(args.code || '', 80);
  const passportId = normalizeToken(args['passport-id'] || args.passport_id || '', 160) || null;
  const apply = toBool(args.apply, policy.shadow_only !== true);
  if (!aliasId) throw new Error('alias_id_required');
  if (!codeRaw) throw new Error('code_required');

  const key = resolveKey(policy);
  if (!key.ok) throw new Error(String(key.error || 'alias_vault_key_required'));

  const index = loadIndex(policy);
  const alias = findAlias(index, aliasId);
  if (!alias) throw new Error('alias_not_found');
  if (!isActiveAlias(alias, nowMs)) throw new Error('alias_inactive_or_expired');

  const envelope = encryptCode(codeRaw, key.key);
  const codeId = `code_${sha16(`${aliasId}|${nowTs}|${Math.random()}`)}`;
  const expiresAt = new Date(nowMs + (Number(policy.code_ttl_minutes || 30) * 60 * 1000)).toISOString();
  const event = {
    code_id: codeId,
    source,
    received_at: nowTs,
    expires_at: expiresAt,
    consumed_at: null,
    envelope
  };
  if (apply) {
    const codes = Array.isArray(alias.codes) ? alias.codes : [];
    codes.push(event);
    alias.codes = codes.slice(-64);
    saveIndex(policy, index, nowTs);
  }
  writeReceipt(policy, {
    action: 'route_code',
    ok: true,
    apply,
    alias_id: aliasId,
    code_id: codeId,
    code_hash: envelope.code_hash,
    source,
    passport_id: passportId
  });
  const out = {
    ok: true,
    type: 'alias_vault_route_code',
    ts: nowTs,
    apply,
    alias_id: aliasId,
    code_id: codeId,
    source,
    queued_codes: Array.isArray(alias.codes) ? alias.codes.length : (apply ? 1 : 0),
    code_hash: envelope.code_hash,
    receipts_path: relPath(policy.state.receipts_path)
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function commandConsumeCode(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const aliasId = normalizeToken(args['alias-id'] || args.alias_id || '', 160);
  const peek = toBool(args.peek, false);
  const reveal = toBool(args.reveal, policy.redaction.show_plaintext_codes_by_default === true);
  const apply = toBool(args.apply, policy.shadow_only !== true);
  if (!aliasId) throw new Error('alias_id_required');

  const key = resolveKey(policy);
  if (!key.ok) throw new Error(String(key.error || 'alias_vault_key_required'));

  const index = loadIndex(policy);
  const alias = findAlias(index, aliasId);
  if (!alias) throw new Error('alias_not_found');
  const codes = Array.isArray(alias.codes) ? alias.codes : [];
  let selected: AnyObj | null = null;
  for (let i = codes.length - 1; i >= 0; i -= 1) {
    const row = codes[i];
    const expMs = parseIsoMs(row && row.expires_at);
    const consumed = !!(row && row.consumed_at);
    if (consumed) continue;
    if (expMs != null && expMs <= nowMs) continue;
    selected = row;
    break;
  }
  if (!selected) {
    const out = {
      ok: true,
      type: 'alias_vault_consume_code',
      ts: nowTs,
      apply,
      alias_id: aliasId,
      found: false
    };
    writeJsonAtomic(policy.state.latest_path, out);
    return out;
  }

  const codeValue = decryptCode(selected.envelope || {}, key.key);
  if (apply && !peek) {
    selected.consumed_at = nowTs;
    saveIndex(policy, index, nowTs);
  }
  writeReceipt(policy, {
    action: 'consume_code',
    ok: true,
    apply,
    alias_id: aliasId,
    code_id: selected.code_id,
    code_hash: selected.envelope && selected.envelope.code_hash || null,
    consumed: !peek
  });
  const out = {
    ok: true,
    type: 'alias_vault_consume_code',
    ts: nowTs,
    apply,
    alias_id: aliasId,
    found: true,
    code_id: selected.code_id,
    source: selected.source || null,
    received_at: selected.received_at || null,
    consumed: !peek,
    code: reveal ? codeValue : '***',
    code_hash: selected.envelope && selected.envelope.code_hash || null
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function commandRevoke(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const aliasId = normalizeToken(args['alias-id'] || args.alias_id || '', 160);
  const reason = cleanText(args.reason || 'revoked', 180) || 'revoked';
  const passportId = normalizeToken(args['passport-id'] || args.passport_id || '', 160) || null;
  const apply = toBool(args.apply, policy.shadow_only !== true);
  if (!aliasId) throw new Error('alias_id_required');

  const index = loadIndex(policy);
  const alias = findAlias(index, aliasId);
  if (!alias) throw new Error('alias_not_found');
  const previous = String(alias.status || 'active');
  if (apply) {
    alias.status = 'revoked';
    alias.revoked_at = nowTs;
    alias.revocation_reason = reason;
    saveIndex(policy, index, nowTs);
  }
  writeReceipt(policy, {
    action: 'revoke',
    ok: true,
    apply,
    alias_id: aliasId,
    previous_status: previous,
    reason,
    passport_id: passportId
  });
  const out = {
    ok: true,
    type: 'alias_vault_revoke',
    ts: nowTs,
    apply,
    alias_id: aliasId,
    previous_status: previous,
    status: apply ? 'revoked' : previous,
    reason
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function commandCleanup(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const apply = toBool(args.apply, policy.shadow_only !== true);
  const retentionMs = Number(policy.cleanup_retention_hours || 24 * 30) * 60 * 60 * 1000;
  const index = loadIndex(policy);
  const aliases = Array.isArray(index.aliases) ? index.aliases : [];
  let expired = 0;
  let pruned = 0;
  let removedAliases = 0;
  for (const alias of aliases) {
    const expMs = parseIsoMs(alias && alias.expires_at);
    if (String(alias && alias.status || '') === 'active' && expMs != null && expMs <= nowMs) {
      expired += 1;
      if (apply) {
        alias.status = 'expired';
        alias.expired_at = nowTs;
      }
    }
    const codes = Array.isArray(alias && alias.codes) ? alias.codes : [];
    const keep: AnyObj[] = [];
    for (const row of codes) {
      const codeExpMs = parseIsoMs(row && row.expires_at);
      const consumedMs = parseIsoMs(row && row.consumed_at);
      const staleConsumed = consumedMs != null && (nowMs - consumedMs) > retentionMs;
      const staleExpired = codeExpMs != null && codeExpMs <= nowMs && (nowMs - codeExpMs) > retentionMs;
      if (staleConsumed || staleExpired) {
        pruned += 1;
        continue;
      }
      keep.push(row);
    }
    if (apply) alias.codes = keep;
  }
  const keptAliases: AnyObj[] = [];
  for (const alias of aliases) {
    const status = String(alias && alias.status || '');
    const terminal = status === 'revoked' || status === 'expired';
    const ts = parseIsoMs(alias && (alias.revoked_at || alias.expired_at || alias.expires_at));
    const stale = terminal && ts != null && (nowMs - ts) > retentionMs;
    if (stale) {
      removedAliases += 1;
      continue;
    }
    keptAliases.push(alias);
  }
  if (apply) {
    index.aliases = keptAliases;
    saveIndex(policy, index, nowTs);
  }
  writeReceipt(policy, {
    action: 'cleanup',
    ok: true,
    apply,
    expired_aliases: expired,
    pruned_codes: pruned,
    removed_aliases: removedAliases
  });
  const out = {
    ok: true,
    type: 'alias_vault_cleanup',
    ts: nowTs,
    apply,
    expired_aliases: expired,
    pruned_codes: pruned,
    removed_aliases: removedAliases,
    remaining_aliases: apply ? keptAliases.length : aliases.length
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function summarizeAlias(alias: AnyObj) {
  if (!alias || typeof alias !== 'object') return null;
  const codes = Array.isArray(alias.codes) ? alias.codes : [];
  const unconsumed = codes.filter((row) => !(row && row.consumed_at)).length;
  return {
    alias_id: alias.alias_id,
    channel: alias.channel,
    address_redacted: redactAddress(String(alias.channel || ''), String(alias.address || '')),
    purpose: alias.purpose || null,
    status: alias.status || 'unknown',
    issued_at: alias.issued_at || null,
    expires_at: alias.expires_at || null,
    passport_id: alias.passport_id || null,
    queued_codes: codes.length,
    unconsumed_codes: unconsumed
  };
}

function commandStatus(args: AnyObj, policy: AnyObj) {
  const nowTs = cleanText(args.now || args['now-ts'], 64) || nowIso();
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const aliasId = normalizeToken(args['alias-id'] || args.alias_id || '', 160) || null;
  const index = loadIndex(policy);
  const aliases = Array.isArray(index.aliases) ? index.aliases : [];
  const activeCount = aliases.filter((row) => isActiveAlias(row, nowMs)).length;
  if (aliasId) {
    const alias = findAlias(index, aliasId);
    return {
      ok: true,
      type: 'alias_vault_status',
      ts: nowTs,
      alias: summarizeAlias(alias),
      index_path: relPath(policy.state.index_path),
      receipts_path: relPath(policy.state.receipts_path)
    };
  }
  return {
    ok: true,
    type: 'alias_vault_status',
    ts: nowTs,
    shadow_only: policy.shadow_only === true,
    key_env: policy.key_env,
    total_aliases: aliases.length,
    active_aliases: activeCount,
    sample_aliases: aliases.slice(-10).map((row: AnyObj) => summarizeAlias(row)),
    index_path: relPath(policy.state.index_path),
    receipts_path: relPath(policy.state.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === 'help' || cmd === '-h') {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'alias_vault_help',
      script: 'alias_verification_vault.js',
      usage: [
        'alias_verification_vault.js issue --channel=email|sms [--purpose=<txt>] [--ttl-hours=<n>] [--passport-id=<id>] [--apply=1|0]',
        'alias_verification_vault.js route-code --alias-id=<id> --code=<txt> [--source=<txt>] [--passport-id=<id>] [--apply=1|0]',
        'alias_verification_vault.js consume-code --alias-id=<id> [--peek=1|0] [--reveal=1|0] [--apply=1|0]',
        'alias_verification_vault.js revoke --alias-id=<id> [--reason=<txt>] [--passport-id=<id>] [--apply=1|0]',
        'alias_verification_vault.js cleanup [--apply=1|0]',
        'alias_verification_vault.js status [--alias-id=<id>]'
      ]
    }) + '\n');
    return;
  }

  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  ensureDir(policy.state.root);
  if (policy.enabled !== true) {
    throw new Error('alias_vault_disabled');
  }

  let out;
  if (cmd === 'issue') out = commandIssue(args, policy);
  else if (cmd === 'route-code') out = commandRouteCode(args, policy);
  else if (cmd === 'consume-code') out = commandConsumeCode(args, policy);
  else if (cmd === 'revoke') out = commandRevoke(args, policy);
  else if (cmd === 'cleanup') out = commandCleanup(args, policy);
  else if (cmd === 'status') out = commandStatus(args, policy);
  else throw new Error(`unknown_command:${cmd}`);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`alias_verification_vault.js: FAIL: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  commandIssue,
  commandRouteCode,
  commandConsumeCode,
  commandRevoke,
  commandCleanup,
  commandStatus
};

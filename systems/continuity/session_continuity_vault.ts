#!/usr/bin/env node
'use strict';
export {};

/**
 * session_continuity_vault.js
 *
 * V2-064:
 * - Encrypted continuity checkpoint vault.
 * - Integrity-verified restore path with rollback-safe recovery snapshot.
 * - Adjacency to active_state_bridge checkpoints.
 *
 * Usage:
 *   node systems/continuity/session_continuity_vault.js archive --writer=<id> [--checkpoint=<id>] [--label=<txt>] [--apply=1|0]
 *   node systems/continuity/session_continuity_vault.js restore --writer=<id> --vault-id=<id> [--dry-run=1]
 *   node systems/continuity/session_continuity_vault.js verify --vault-id=<id>
 *   node systems/continuity/session_continuity_vault.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.CONTINUITY_ROOT
  ? path.resolve(process.env.CONTINUITY_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SESSION_CONTINUITY_VAULT_POLICY_PATH
  ? path.resolve(process.env.SESSION_CONTINUITY_VAULT_POLICY_PATH)
  : path.join(ROOT, 'config', 'session_continuity_vault_policy.json');

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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    auto_archive_on_checkpoint: true,
    key_env: 'SESSION_CONTINUITY_VAULT_KEY',
    key_min_length: 24,
    max_index_entries: 500,
    source: {
      checkpoint_dir: 'state/continuity/checkpoints',
      index_path: 'state/continuity/checkpoints/index.json'
    },
    state: {
      root: 'state/continuity/vault',
      checkpoint_dir: 'state/continuity/vault/checkpoints',
      index_path: 'state/continuity/vault/index.json',
      latest_path: 'state/continuity/vault/latest.json',
      receipts_path: 'state/continuity/vault/receipts.jsonl',
      recovery_dir: 'state/continuity/vault/recovery'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const source = src.source && typeof src.source === 'object' ? src.source : {};
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  return {
    version: cleanText(src.version || base.version, 24) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    auto_archive_on_checkpoint: src.auto_archive_on_checkpoint !== false,
    key_env: cleanText(src.key_env || base.key_env, 80) || base.key_env,
    key_min_length: clampInt(src.key_min_length, 8, 4096, base.key_min_length),
    max_index_entries: clampInt(src.max_index_entries, 10, 50000, base.max_index_entries),
    source: {
      checkpoint_dir: resolvePath(source.checkpoint_dir || base.source.checkpoint_dir, base.source.checkpoint_dir),
      index_path: resolvePath(source.index_path || base.source.index_path, base.source.index_path)
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      checkpoint_dir: resolvePath(state.checkpoint_dir || base.state.checkpoint_dir, base.state.checkpoint_dir),
      index_path: resolvePath(state.index_path || base.state.index_path, base.state.index_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      recovery_dir: resolvePath(state.recovery_dir || base.state.recovery_dir, base.state.recovery_dir)
    }
  };
}

function resolveKey(policy: AnyObj) {
  const envName = cleanText(policy.key_env || '', 80) || 'SESSION_CONTINUITY_VAULT_KEY';
  const raw = String(process.env[envName] || '');
  if (raw.length < Number(policy.key_min_length || 24)) {
    return { ok: false, env_name: envName, error: 'vault_key_missing_or_too_short' };
  }
  return { ok: true, env_name: envName, key: raw };
}

function deriveKey(secret: string, saltB64: string, iterations = 120000) {
  const salt = Buffer.from(String(saltB64 || ''), 'base64');
  return crypto.pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
}

function encryptPayload(payload: AnyObj, secret: string) {
  const salt = crypto.randomBytes(16).toString('base64');
  const iv = crypto.randomBytes(12).toString('base64');
  const iterations = 120000;
  const key = deriveKey(secret, salt, iterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  const plaintext = Buffer.from(stableStringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'pbkdf2-sha256',
    iterations,
    salt,
    iv,
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintext_hash: shaHex(payload)
  };
}

function decryptPayload(envelope: AnyObj, secret: string) {
  const key = deriveKey(secret, String(envelope.salt || ''), Number(envelope.iterations || 120000));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv || ''), 'base64'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64')),
    decipher.final()
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  const hash = shaHex(parsed);
  if (hash !== String(envelope.plaintext_hash || '')) {
    throw new Error('vault_plaintext_hash_mismatch');
  }
  return parsed;
}

function loadSourceCheckpoint(policy: AnyObj, checkpointIdRaw: unknown) {
  const checkpointId = normalizeToken(checkpointIdRaw || '', 180);
  if (checkpointId) {
    const directPath = path.join(policy.source.checkpoint_dir, `${checkpointId}.json`);
    const payload = readJson(directPath, null);
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  }
  const index = readJson(policy.source.index_path, { checkpoints: [] });
  const checkpoints = Array.isArray(index && index.checkpoints) ? index.checkpoints : [];
  if (!checkpoints.length) return null;
  const latest = checkpoints[checkpoints.length - 1];
  const latestId = normalizeToken(latest && latest.id || '', 180);
  if (!latestId) return null;
  const latestPath = path.join(policy.source.checkpoint_dir, `${latestId}.json`);
  const payload = readJson(latestPath, null);
  return payload && typeof payload === 'object' ? payload : null;
}

function normalizeDocs(src: AnyObj) {
  const docs = Array.isArray(src && src.docs) ? src.docs : [];
  const out: AnyObj[] = [];
  for (const row of docs) {
    const rel = String(row && row.path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!rel || rel.includes('..')) continue;
    if (!('value' in (row || {}))) continue;
    out.push({
      path: rel,
      value: row.value
    });
  }
  out.sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
  return out;
}

function loadVaultIndex(policy: AnyObj) {
  const src = readJson(policy.state.index_path, { entries: [] });
  if (!src || typeof src !== 'object') return { entries: [] };
  return {
    entries: Array.isArray(src.entries) ? src.entries : []
  };
}

function saveVaultIndex(policy: AnyObj, index: AnyObj) {
  const entries = Array.isArray(index && index.entries) ? index.entries.slice(-Number(policy.max_index_entries || 500)) : [];
  writeJsonAtomic(policy.state.index_path, {
    schema_id: 'session_continuity_vault_index',
    schema_version: '1.0',
    updated_at: nowIso(),
    entries
  });
}

function archive(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/session_continuity_vault_policy.json');
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'session_continuity_vault_archive', error: 'policy_disabled' };
  }
  const writer = normalizeToken(args.writer || '', 120);
  if (!writer) {
    return { ok: false, type: 'session_continuity_vault_archive', error: 'writer_required' };
  }
  const source = loadSourceCheckpoint(policy, args.checkpoint || args['checkpoint-id'] || '');
  if (!source) {
    return { ok: false, type: 'session_continuity_vault_archive', error: 'source_checkpoint_not_found' };
  }
  const docs = normalizeDocs(source);
  const sourceCheckpointId = normalizeToken(source.id || args.checkpoint || '', 180) || null;
  const vaultId = `vault_${crypto.createHash('sha256')
    .update(`${writer}|${sourceCheckpointId || 'none'}|${nowIso()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const label = cleanText(args.label || source.label || '', 160) || null;
  const payload = {
    schema_id: 'session_continuity_vault_payload',
    schema_version: '1.0',
    vault_id: vaultId,
    ts: nowIso(),
    writer,
    label,
    source_checkpoint_id: sourceCheckpointId,
    docs
  };
  const keyInfo = resolveKey(policy);
  if (!keyInfo.ok) {
    return {
      ok: false,
      type: 'session_continuity_vault_archive',
      error: keyInfo.error,
      key_env: keyInfo.env_name
    };
  }
  const envelopeCore = encryptPayload(payload, keyInfo.key);
  const envelope = {
    schema_id: 'session_continuity_vault_envelope',
    schema_version: '1.0',
    vault_id: vaultId,
    writer,
    source_checkpoint_id: sourceCheckpointId,
    label,
    key_env: keyInfo.env_name,
    ...envelopeCore
  };
  const apply = toBool(args.apply, true);
  if (policy.shadow_only !== true && apply) {
    ensureDir(policy.state.checkpoint_dir);
    const outPath = path.join(policy.state.checkpoint_dir, `${vaultId}.json`);
    writeJsonAtomic(outPath, envelope);
    const index = loadVaultIndex(policy);
    index.entries.push({
      vault_id: vaultId,
      ts: payload.ts,
      writer,
      source_checkpoint_id: sourceCheckpointId,
      label,
      docs: docs.length,
      plaintext_hash: envelope.plaintext_hash,
      path: relPath(outPath)
    });
    saveVaultIndex(policy, index);
  }
  const out = {
    ok: true,
    type: 'session_continuity_vault_archive',
    ts: payload.ts,
    vault_id: vaultId,
    writer,
    source_checkpoint_id: sourceCheckpointId,
    docs: docs.length,
    shadow_only: policy.shadow_only === true || !apply
  };
  appendJsonl(policy.state.receipts_path, out);
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function loadVaultEnvelope(policy: AnyObj, vaultIdRaw: unknown) {
  const vaultId = normalizeToken(vaultIdRaw || '', 180);
  if (!vaultId) return null;
  const filePath = path.join(policy.state.checkpoint_dir, `${vaultId}.json`);
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') return null;
  return payload;
}

function restore(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/session_continuity_vault_policy.json');
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'session_continuity_vault_restore', error: 'policy_disabled' };
  }
  const writer = normalizeToken(args.writer || '', 120);
  if (!writer) return { ok: false, type: 'session_continuity_vault_restore', error: 'writer_required' };
  const vaultId = normalizeToken(args['vault-id'] || args.vault_id || args.vault || '', 180);
  if (!vaultId) return { ok: false, type: 'session_continuity_vault_restore', error: 'vault_id_required' };
  const envelope = loadVaultEnvelope(policy, vaultId);
  if (!envelope) return { ok: false, type: 'session_continuity_vault_restore', error: 'vault_not_found', vault_id: vaultId };
  const keyInfo = resolveKey(policy);
  if (!keyInfo.ok) {
    return {
      ok: false,
      type: 'session_continuity_vault_restore',
      error: keyInfo.error,
      key_env: keyInfo.env_name
    };
  }
  let payload: AnyObj;
  try {
    payload = decryptPayload(envelope, keyInfo.key);
  } catch (err) {
    return {
      ok: false,
      type: 'session_continuity_vault_restore',
      error: String(err && err.message || err || 'vault_decrypt_failed'),
      vault_id: vaultId
    };
  }
  const docs = normalizeDocs(payload);
  const dryRun = toBool(args['dry-run'] || args.dry_run, false);
  const restoreId = `restore_${crypto.createHash('sha256')
    .update(`${vaultId}|${writer}|${nowIso()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const rollbackSnapshot: AnyObj = {
    schema_id: 'session_continuity_vault_recovery',
    schema_version: '1.0',
    restore_id: restoreId,
    ts: nowIso(),
    writer,
    vault_id: vaultId,
    files: []
  };
  const touched: AnyObj[] = [];
  let rollbackApplied = false;
  try {
    for (const row of docs) {
      const abs = path.join(ROOT, row.path);
      const existed = fs.existsSync(abs);
      const before = existed ? readJson(abs, null) : null;
      rollbackSnapshot.files.push({
        path: row.path,
        existed,
        value: before
      });
      if (dryRun || policy.shadow_only === true) {
        touched.push({ path: row.path, applied: false, dry_run: true });
        continue;
      }
      writeJsonAtomic(abs, row.value);
      touched.push({ path: row.path, applied: true, dry_run: false });
    }
  } catch (err) {
    if (!dryRun && policy.shadow_only !== true) {
      for (const row of rollbackSnapshot.files) {
        const abs = path.join(ROOT, row.path);
        if (row.existed) writeJsonAtomic(abs, row.value);
        else if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      }
      rollbackApplied = true;
    }
    return {
      ok: false,
      type: 'session_continuity_vault_restore',
      error: String(err && err.message || err || 'restore_apply_failed'),
      vault_id: vaultId,
      rollback_applied: rollbackApplied
    };
  }
  const recoveryPath = path.join(policy.state.recovery_dir, `${restoreId}.json`);
  if (!dryRun && policy.shadow_only !== true) writeJsonAtomic(recoveryPath, rollbackSnapshot);
  const out = {
    ok: true,
    type: 'session_continuity_vault_restore',
    ts: nowIso(),
    restore_id: restoreId,
    writer,
    vault_id: vaultId,
    dry_run: dryRun || policy.shadow_only === true,
    files_total: docs.length,
    files_applied: touched.filter((row) => row.applied).length,
    rollback_snapshot_path: dryRun || policy.shadow_only === true ? null : relPath(recoveryPath),
    rollback_applied: rollbackApplied,
    source_checkpoint_id: cleanText(payload.source_checkpoint_id || '', 180) || null
  };
  appendJsonl(policy.state.receipts_path, out);
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function verify(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/session_continuity_vault_policy.json');
  const policy = loadPolicy(policyPath);
  const vaultId = normalizeToken(args['vault-id'] || args.vault_id || args.vault || '', 180);
  if (!vaultId) return { ok: false, type: 'session_continuity_vault_verify', error: 'vault_id_required' };
  const envelope = loadVaultEnvelope(policy, vaultId);
  if (!envelope) return { ok: false, type: 'session_continuity_vault_verify', error: 'vault_not_found', vault_id: vaultId };
  const keyInfo = resolveKey(policy);
  if (!keyInfo.ok) {
    return {
      ok: false,
      type: 'session_continuity_vault_verify',
      error: keyInfo.error,
      key_env: keyInfo.env_name
    };
  }
  try {
    const payload = decryptPayload(envelope, keyInfo.key);
    const docs = normalizeDocs(payload);
    const out = {
      ok: true,
      type: 'session_continuity_vault_verify',
      ts: nowIso(),
      vault_id: vaultId,
      docs: docs.length,
      source_checkpoint_id: cleanText(payload.source_checkpoint_id || '', 180) || null
    };
    appendJsonl(policy.state.receipts_path, out);
    writeJsonAtomic(policy.state.latest_path, out);
    return out;
  } catch (err) {
    return {
      ok: false,
      type: 'session_continuity_vault_verify',
      error: String(err && err.message || err || 'vault_verify_failed'),
      vault_id: vaultId
    };
  }
}

function status(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/session_continuity_vault_policy.json');
  const policy = loadPolicy(policyPath);
  const index = loadVaultIndex(policy);
  const latest = index.entries.length ? index.entries[index.entries.length - 1] : null;
  return {
    ok: true,
    type: 'session_continuity_vault_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      auto_archive_on_checkpoint: policy.auto_archive_on_checkpoint === true
    },
    counts: {
      vault_entries: index.entries.length
    },
    latest: latest
      ? {
        vault_id: latest.vault_id || null,
        ts: latest.ts || null,
        writer: latest.writer || null,
        docs: Number(latest.docs || 0)
      }
      : null,
    paths: {
      checkpoint_dir: relPath(policy.state.checkpoint_dir),
      index_path: relPath(policy.state.index_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/continuity/session_continuity_vault.js archive --writer=<id> [--checkpoint=<id>] [--label=<txt>] [--apply=1|0]');
  console.log('  node systems/continuity/session_continuity_vault.js restore --writer=<id> --vault-id=<id> [--dry-run=1]');
  console.log('  node systems/continuity/session_continuity_vault.js verify --vault-id=<id>');
  console.log('  node systems/continuity/session_continuity_vault.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'archive') out = archive(args);
  else if (cmd === 'restore') out = restore(args);
  else if (cmd === 'verify') out = verify(args);
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
  archive,
  restore,
  verify,
  status
};


#!/usr/bin/env node
'use strict';

/**
 * offsite_backup.js
 *
 * Encrypted offsite backup sync + restore-drill verification.
 *
 * Usage:
 *   node systems/ops/offsite_backup.js sync [--profile=<id>] [--snapshot=<id>] [--source-dest=<abs_path>] [--offsite-dest=<abs_path>] [--strict=1|0] [--policy=<abs_path>]
 *   node systems/ops/offsite_backup.js restore-drill [--profile=<id>] [--snapshot=<id>] [--dest=<abs_path>] [--strict=1|0] [--policy=<abs_path>]
 *   node systems/ops/offsite_backup.js status [--profile=<id>] [--policy=<abs_path>]
 *   node systems/ops/offsite_backup.js diagnose [--profile=<id>] [--limit=N] [--policy=<abs_path>]
 *   node systems/ops/offsite_backup.js list [--profile=<id>] [--limit=N] [--policy=<abs_path>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.OFFSITE_BACKUP_POLICY_PATH
  ? path.resolve(process.env.OFFSITE_BACKUP_POLICY_PATH)
  : path.join(ROOT, 'config', 'offsite_backup_policy.json');
const SYNC_RECEIPTS_PATH = process.env.OFFSITE_BACKUP_SYNC_RECEIPTS_PATH
  ? path.resolve(process.env.OFFSITE_BACKUP_SYNC_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'offsite_backup_sync_receipts.jsonl');
const DRILL_RECEIPTS_PATH = process.env.OFFSITE_BACKUP_DRILL_RECEIPTS_PATH
  ? path.resolve(process.env.OFFSITE_BACKUP_DRILL_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'ops', 'offsite_restore_drill_receipts.jsonl');

type AnyObj = Record<string, any>;

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/offsite_backup.js sync [--profile=<id>] [--snapshot=<id>] [--source-dest=<abs_path>] [--offsite-dest=<abs_path>] [--strict=1|0] [--policy=<abs_path>]');
  console.log('  node systems/ops/offsite_backup.js restore-drill [--profile=<id>] [--snapshot=<id>] [--dest=<abs_path>] [--strict=1|0] [--policy=<abs_path>]');
  console.log('  node systems/ops/offsite_backup.js status [--profile=<id>] [--policy=<abs_path>]');
  console.log('  node systems/ops/offsite_backup.js diagnose [--profile=<id>] [--limit=N] [--policy=<abs_path>]');
  console.log('  node systems/ops/offsite_backup.js list [--profile=<id>] [--limit=N] [--policy=<abs_path>]');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
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

function nowIso(): string {
  return new Date().toISOString();
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, '-');
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

function readJsonl(filePath: string): AnyObj[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendJsonl(filePath: string, row: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function trimJsonl(filePath: string, keepRows: unknown): void {
  const rows = readJsonl(filePath);
  const limit = Math.max(10, Number(keepRows || 180));
  if (rows.length <= limit) return;
  const tail = rows.slice(-limit).map((row) => JSON.stringify(row));
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${tail.join('\n')}\n`, 'utf8');
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeText(v: unknown, maxLen = 4096): string {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function expandHome(p: unknown): string {
  const raw = normalizeText(p);
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function relSafe(rawPath: unknown): string {
  const rel = String(rawPath == null ? '' : rawPath)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!rel || rel === '.' || rel.includes('..')) {
    throw new Error(`invalid_relative_path:${String(rawPath || '')}`);
  }
  return rel;
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Buffer(fs.readFileSync(filePath));
}

function parseDateMs(v: unknown): number | null {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseSnapshotTsMs(snapshotId: unknown): number | null {
  const raw = normalizeText(snapshotId, 120);
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return parseDateMs(iso);
}

function listSnapshotIds(profileDir: string): string[] {
  if (!fs.existsSync(profileDir)) return [];
  return fs.readdirSync(profileDir)
    .filter((id: string) => {
      try {
        return fs.statSync(path.join(profileDir, id)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function defaultPolicy(): AnyObj {
  return {
    version: '1.0',
    default_profile: 'runtime_state',
    source: {
      destination_env: 'STATE_BACKUP_DEST',
      destination_default: '~/.openclaw/backups/workspace-state'
    },
    offsite: {
      destination_env: 'STATE_BACKUP_OFFSITE_DEST',
      destination_default: '~/.openclaw/backups/workspace-state-offsite'
    },
    encryption: {
      algorithm: 'aes-256-gcm',
      key_env: 'STATE_BACKUP_OFFSITE_KEY',
      key_min_bytes: 32
    },
    sync: {
      strict_default: true,
      verify_write: true,
      verify_sample_files: 2000,
      max_history: 180
    },
    restore_drill: {
      strict_default: true,
      cadence_days: 30,
      destination_default: '~/.openclaw/backups/offsite-restore-drills',
      rto_target_minutes: 30,
      rpo_target_hours: 24,
      max_history: 180
    }
  };
}

function loadPolicy(policyArg?: unknown): AnyObj {
  const policyPath = policyArg ? path.resolve(String(policyArg)) : POLICY_PATH;
  const base = defaultPolicy();
  const raw: AnyObj = readJsonSafe(policyPath, {});
  const source = raw && typeof raw.source === 'object' ? raw.source : {};
  const offsite = raw && typeof raw.offsite === 'object' ? raw.offsite : {};
  const encryption = raw && typeof raw.encryption === 'object' ? raw.encryption : {};
  const sync = raw && typeof raw.sync === 'object' ? raw.sync : {};
  const restore = raw && typeof raw.restore_drill === 'object' ? raw.restore_drill : {};

  return {
    version: normalizeText(raw.version || base.version, 24) || '1.0',
    path: policyPath,
    default_profile: normalizeText(raw.default_profile || base.default_profile, 120) || 'runtime_state',
    source: {
      destination_env: normalizeText(source.destination_env || base.source.destination_env, 120) || 'STATE_BACKUP_DEST',
      destination_default: normalizeText(source.destination_default || base.source.destination_default, 1024)
    },
    offsite: {
      destination_env: normalizeText(offsite.destination_env || base.offsite.destination_env, 120) || 'STATE_BACKUP_OFFSITE_DEST',
      destination_default: normalizeText(offsite.destination_default || base.offsite.destination_default, 1024)
    },
    encryption: {
      algorithm: normalizeText(encryption.algorithm || base.encryption.algorithm, 64) || 'aes-256-gcm',
      key_env: normalizeText(encryption.key_env || base.encryption.key_env, 120) || 'STATE_BACKUP_OFFSITE_KEY',
      key_min_bytes: clampInt(encryption.key_min_bytes, 16, 256, Number(base.encryption.key_min_bytes || 32))
    },
    sync: {
      strict_default: toBool(sync.strict_default, toBool(base.sync.strict_default, true)),
      verify_write: toBool(sync.verify_write, toBool(base.sync.verify_write, true)),
      verify_sample_files: clampInt(sync.verify_sample_files, 1, 50000, Number(base.sync.verify_sample_files || 2000)),
      max_history: clampInt(sync.max_history, 10, 5000, Number(base.sync.max_history || 180))
    },
    restore_drill: {
      strict_default: toBool(restore.strict_default, toBool(base.restore_drill.strict_default, true)),
      cadence_days: clampInt(restore.cadence_days, 1, 3650, Number(base.restore_drill.cadence_days || 30)),
      destination_default: normalizeText(restore.destination_default || base.restore_drill.destination_default, 1024),
      rto_target_minutes: Math.max(1, Number(restore.rto_target_minutes || base.restore_drill.rto_target_minutes || 30)),
      rpo_target_hours: Math.max(1, Number(restore.rpo_target_hours || base.restore_drill.rpo_target_hours || 24)),
      max_history: clampInt(restore.max_history, 10, 5000, Number(base.restore_drill.max_history || 180))
    }
  };
}

function resolveDestination(argsValue: unknown, envKey: unknown, fallbackPath: unknown): string {
  const fromArg = normalizeText(argsValue, 2000);
  const envName = normalizeText(envKey, 120);
  const fromEnv = envName ? normalizeText(process.env[envName], 2000) : '';
  const fallback = normalizeText(expandHome(fallbackPath), 2000);
  const selected = fromArg || fromEnv || fallback;
  if (!selected) throw new Error('destination_missing');
  const abs = path.resolve(expandHome(selected));
  if (!path.isAbsolute(abs)) throw new Error('destination_must_be_absolute');
  return abs;
}

function loadLocalSnapshotContext(policy: AnyObj, args: AnyObj): AnyObj {
  const profile = normalizeText(args.profile || policy.default_profile, 120) || 'runtime_state';
  const sourceDest = resolveDestination(args['source-dest'] || args.source_dest, policy.source.destination_env, policy.source.destination_default);
  const profileDir = path.join(sourceDest, profile);
  const ids = listSnapshotIds(profileDir);
  if (!ids.length) throw new Error(`source_snapshot_missing profile=${profile}`);
  const snapshotId = normalizeText(args.snapshot, 120) || ids[ids.length - 1];
  const snapshotDir = path.join(profileDir, snapshotId);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') throw new Error(`source_manifest_missing snapshot=${snapshotId}`);
  const manifestType = normalizeText(manifest.type, 120);
  if (manifestType !== 'state_backup_snapshot') {
    throw new Error(`source_manifest_type_invalid expected=state_backup_snapshot actual=${manifestType || 'unknown'}`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  return {
    profile,
    source_dest: sourceDest,
    profile_dir: profileDir,
    snapshot_id: snapshotId,
    snapshot_dir: snapshotDir,
    manifest_path: manifestPath,
    manifest,
    files
  };
}

function normalizeKeyBuffer(rawKey: string): Buffer {
  const text = normalizeText(rawKey, 10000);
  if (!text) return Buffer.alloc(0);
  let material = Buffer.from(text, 'utf8');
  if (text.startsWith('hex:')) {
    const hex = text.slice(4).replace(/\s+/g, '');
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      material = Buffer.from(hex, 'hex');
    } else {
      material = Buffer.alloc(0);
    }
  } else if (text.startsWith('base64:')) {
    try {
      material = Buffer.from(text.slice(7), 'base64');
    } catch {
      material = Buffer.alloc(0);
    }
  }
  if (!material.length) return Buffer.alloc(0);
  return crypto.createHash('sha256').update(material).digest();
}

function loadEncryptionKey(policy: AnyObj): AnyObj {
  const keyEnv = normalizeText(policy.encryption && policy.encryption.key_env, 120) || 'STATE_BACKUP_OFFSITE_KEY';
  const rawKey = normalizeText(process.env[keyEnv], 10000);
  const key = normalizeKeyBuffer(rawKey);
  const minBytes = clampInt(policy.encryption && policy.encryption.key_min_bytes, 16, 256, 32);
  if (!key.length || key.length < Math.min(32, minBytes)) {
    return {
      ok: false,
      reason: 'offsite_encryption_key_missing_or_invalid',
      key_env: keyEnv
    };
  }
  return {
    ok: true,
    key,
    key_env: keyEnv,
    key_fingerprint: sha256Buffer(key).slice(0, 16)
  };
}

function encryptBuffer(plain: Buffer, key: Buffer): AnyObj {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted,
    iv_hex: iv.toString('hex'),
    tag_hex: tag.toString('hex')
  };
}

function decryptBuffer(encrypted: Buffer, key: Buffer, ivHex: string, tagHex: string): Buffer {
  const iv = Buffer.from(String(ivHex || ''), 'hex');
  const tag = Buffer.from(String(tagHex || ''), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function cmdSync(args: AnyObj): AnyObj {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, toBool(policy.sync.strict_default, true));
  const keyState = loadEncryptionKey(policy);
  const startedMs = Date.now();
  const startedAt = nowIso();

  let out: AnyObj;
  if (!keyState.ok) {
    out = {
      ok: false,
      type: 'offsite_backup_sync',
      ts: nowIso(),
      strict,
      reason: keyState.reason,
      key_env: keyState.key_env || null
    };
    appendJsonl(SYNC_RECEIPTS_PATH, out);
    trimJsonl(SYNC_RECEIPTS_PATH, policy.sync.max_history);
    process.stdout.write(JSON.stringify(out) + '\n');
    if (strict) process.exitCode = 1;
    return out;
  }

  const source = loadLocalSnapshotContext(policy, args);
  const offsiteDest = resolveDestination(args['offsite-dest'] || args.offsite_dest, policy.offsite.destination_env, policy.offsite.destination_default);
  const offsiteProfileDir = path.join(offsiteDest, source.profile);
  const offsiteSnapshotDir = path.join(offsiteProfileDir, source.snapshot_id);
  const payloadDir = path.join(offsiteSnapshotDir, 'payload');

  if (fs.existsSync(offsiteSnapshotDir)) {
    fs.rmSync(offsiteSnapshotDir, { recursive: true, force: true });
  }
  ensureDir(payloadDir);

  const files = Array.isArray(source.files) ? source.files : [];
  const outFiles = [] as AnyObj[];
  let totalPlainBytes = 0;
  let totalCipherBytes = 0;

  for (const row of files) {
    const rel = relSafe(row && row.path);
    const srcPath = path.join(source.snapshot_dir, rel);
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
      throw new Error(`source_payload_missing:${rel}`);
    }
    const plain = fs.readFileSync(srcPath);
    const encryptedState = encryptBuffer(plain, keyState.key);
    const encRel = `payload/${rel}.enc`;
    const encPath = path.join(offsiteSnapshotDir, encRel);
    ensureDir(path.dirname(encPath));
    fs.writeFileSync(encPath, encryptedState.encrypted);
    const plainSha = normalizeText(row && row.sha256, 128) || sha256Buffer(plain);
    const cipherSha = sha256Buffer(encryptedState.encrypted);
    outFiles.push({
      path: rel,
      size_bytes: Number(plain.length || 0),
      sha256: plainSha,
      encrypted_path: encRel,
      encrypted_size_bytes: Number(encryptedState.encrypted.length || 0),
      encrypted_sha256: cipherSha,
      iv_hex: encryptedState.iv_hex,
      tag_hex: encryptedState.tag_hex
    });
    totalPlainBytes += Number(plain.length || 0);
    totalCipherBytes += Number(encryptedState.encrypted.length || 0);
  }

  const sourceManifestSha = sha256File(source.manifest_path);
  const manifestOut = {
    ts: nowIso(),
    type: 'offsite_encrypted_snapshot',
    profile: source.profile,
    snapshot_id: source.snapshot_id,
    source_destination: source.source_dest,
    source_snapshot_dir: source.snapshot_dir,
    source_manifest_path: source.manifest_path,
    source_manifest_sha256: sourceManifestSha,
    source_snapshot_ts: source.manifest && source.manifest.ts ? String(source.manifest.ts) : null,
    file_count: outFiles.length,
    total_plain_bytes: totalPlainBytes,
    total_cipher_bytes: totalCipherBytes,
    encryption: {
      algorithm: 'aes-256-gcm',
      key_fingerprint: keyState.key_fingerprint
    },
    files: outFiles
  };
  fs.writeFileSync(path.join(offsiteSnapshotDir, 'manifest.json'), JSON.stringify(manifestOut, null, 2));

  let writeVerifyFailures = 0;
  if (toBool(policy.sync.verify_write, true)) {
    const maxVerify = clampInt(policy.sync.verify_sample_files, 1, 50000, 2000);
    const verifyRows = outFiles.slice(0, Math.min(maxVerify, outFiles.length));
    for (const row of verifyRows) {
      const encPath = path.join(offsiteSnapshotDir, row.encrypted_path);
      if (!fs.existsSync(encPath) || !fs.statSync(encPath).isFile()) {
        writeVerifyFailures += 1;
        continue;
      }
      const actualSha = sha256File(encPath);
      if (actualSha !== String(row.encrypted_sha256 || '')) {
        writeVerifyFailures += 1;
      }
    }
  }

  const doneMs = Date.now();
  const sourceTsMs = parseDateMs(source.manifest && source.manifest.ts) || parseSnapshotTsMs(source.snapshot_id);
  const rpoHours = sourceTsMs == null
    ? null
    : Number(((doneMs - sourceTsMs) / 3600000).toFixed(3));

  out = {
    ok: writeVerifyFailures === 0,
    type: 'offsite_backup_sync',
    ts: nowIso(),
    strict,
    profile: source.profile,
    snapshot_id: source.snapshot_id,
    source_destination: source.source_dest,
    offsite_destination: offsiteDest,
    offsite_snapshot_dir: offsiteSnapshotDir,
    file_count: outFiles.length,
    total_plain_bytes: totalPlainBytes,
    total_cipher_bytes: totalCipherBytes,
    key_fingerprint: keyState.key_fingerprint,
    metrics: {
      sync_minutes: Number(((doneMs - startedMs) / 60000).toFixed(3)),
      rpo_hours: rpoHours
    },
    gates: {
      write_verify_failures: writeVerifyFailures,
      write_verify_pass: writeVerifyFailures === 0
    },
    reason: writeVerifyFailures === 0 ? null : 'offsite_write_verify_failed',
    started_at: startedAt,
    completed_at: new Date(doneMs).toISOString()
  };

  appendJsonl(SYNC_RECEIPTS_PATH, out);
  trimJsonl(SYNC_RECEIPTS_PATH, policy.sync.max_history);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && out.ok !== true) process.exitCode = 1;
  return out;
}

function loadOffsiteSnapshotContext(policy: AnyObj, args: AnyObj): AnyObj {
  const profile = normalizeText(args.profile || policy.default_profile, 120) || 'runtime_state';
  const offsiteDest = resolveDestination(args['offsite-dest'] || args.offsite_dest, policy.offsite.destination_env, policy.offsite.destination_default);
  const profileDir = path.join(offsiteDest, profile);
  const ids = listSnapshotIds(profileDir);
  if (!ids.length) throw new Error(`offsite_snapshot_missing profile=${profile}`);
  const snapshotId = normalizeText(args.snapshot, 120) || ids[ids.length - 1];
  const snapshotDir = path.join(profileDir, snapshotId);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') throw new Error(`offsite_manifest_missing snapshot=${snapshotId}`);
  const manifestType = normalizeText(manifest.type, 120);
  if (manifestType !== 'offsite_encrypted_snapshot') {
    throw new Error(`offsite_manifest_type_invalid expected=offsite_encrypted_snapshot actual=${manifestType || 'unknown'}`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  return {
    profile,
    offsite_dest: offsiteDest,
    snapshot_id: snapshotId,
    snapshot_dir: snapshotDir,
    manifest_path: manifestPath,
    manifest,
    files
  };
}

function cmdRestoreDrill(args: AnyObj): AnyObj {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, toBool(policy.restore_drill.strict_default, true));
  const keyState = loadEncryptionKey(policy);
  const startedMs = Date.now();
  const startedAt = nowIso();

  let out: AnyObj;
  if (!keyState.ok) {
    out = {
      ok: false,
      type: 'offsite_restore_drill',
      ts: nowIso(),
      strict,
      reason: keyState.reason,
      key_env: keyState.key_env || null
    };
    appendJsonl(DRILL_RECEIPTS_PATH, out);
    trimJsonl(DRILL_RECEIPTS_PATH, policy.restore_drill.max_history);
    process.stdout.write(JSON.stringify(out) + '\n');
    if (strict) process.exitCode = 1;
    return out;
  }

  const source = loadOffsiteSnapshotContext(policy, args);
  const restoreRoot = resolveDestination(args.dest, 'OFFSITE_RESTORE_DRILL_DEST', policy.restore_drill.destination_default);
  const drillId = normalizeText(args['drill-id'] || args.drill_id, 120) || stamp();
  const restoreDir = path.join(restoreRoot, source.profile, `${source.snapshot_id}_${drillId}`);
  const restorePayloadDir = path.join(restoreDir, 'restored');

  if (fs.existsSync(restoreDir)) {
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
  ensureDir(restorePayloadDir);

  const files = Array.isArray(source.files) ? source.files : [];
  let verified = 0;
  let missing = 0;
  let mismatch = 0;
  let totalBytes = 0;
  const failures = [] as AnyObj[];

  for (const row of files) {
    const rel = relSafe(row && row.path);
    const encRel = relSafe(row && row.encrypted_path);
    const encPath = path.join(source.snapshot_dir, encRel);
    if (!fs.existsSync(encPath) || !fs.statSync(encPath).isFile()) {
      missing += 1;
      failures.push({ path: rel, reason: 'encrypted_payload_missing' });
      continue;
    }
    const encrypted = fs.readFileSync(encPath);
    let plain: Buffer;
    try {
      plain = decryptBuffer(
        encrypted,
        keyState.key,
        normalizeText(row && row.iv_hex, 64),
        normalizeText(row && row.tag_hex, 64)
      );
    } catch {
      mismatch += 1;
      failures.push({ path: rel, reason: 'decrypt_failed' });
      continue;
    }
    const expectedSha = normalizeText(row && row.sha256, 128);
    const actualSha = sha256Buffer(plain);
    if (expectedSha && actualSha !== expectedSha) {
      mismatch += 1;
      failures.push({ path: rel, reason: 'sha_mismatch' });
      continue;
    }
    const dstPath = path.join(restorePayloadDir, rel);
    ensureDir(path.dirname(dstPath));
    fs.writeFileSync(dstPath, plain);
    verified += 1;
    totalBytes += Number(plain.length || 0);
  }

  const doneMs = Date.now();
  const sourceTsMs = parseDateMs(source.manifest && source.manifest.source_snapshot_ts)
    || parseSnapshotTsMs(source.snapshot_id);
  const rpoHours = sourceTsMs == null
    ? null
    : Number(((doneMs - sourceTsMs) / 3600000).toFixed(3));
  const rtoMinutes = Number(((doneMs - startedMs) / 60000).toFixed(3));
  const rtoPass = rtoMinutes <= Number(policy.restore_drill.rto_target_minutes || 30);
  const rpoPass = rpoHours != null && rpoHours <= Number(policy.restore_drill.rpo_target_hours || 24);
  const verifyPass = missing === 0 && mismatch === 0;

  out = {
    ok: verifyPass && rtoPass && rpoPass,
    type: 'offsite_restore_drill',
    ts: nowIso(),
    strict,
    profile: source.profile,
    snapshot_id: source.snapshot_id,
    offsite_destination: source.offsite_dest,
    restore_dir: restoreDir,
    key_fingerprint: keyState.key_fingerprint,
    file_count: files.length,
    verified_files: verified,
    restored_bytes: totalBytes,
    failures: failures.slice(0, 100),
    metrics: {
      rto_minutes: rtoMinutes,
      rpo_hours: rpoHours
    },
    gates: {
      verify_pass: verifyPass,
      rto_pass: rtoPass,
      rpo_pass: rpoPass,
      rto_target_minutes: Number(policy.restore_drill.rto_target_minutes || 30),
      rpo_target_hours: Number(policy.restore_drill.rpo_target_hours || 24)
    },
    reasons: [
      !verifyPass ? 'restore_verify_failed' : null,
      !rtoPass ? 'rto_exceeded' : null,
      !rpoPass ? 'rpo_exceeded_or_missing_snapshot_ts' : null
    ].filter(Boolean),
    started_at: startedAt,
    completed_at: new Date(doneMs).toISOString()
  };

  appendJsonl(DRILL_RECEIPTS_PATH, out);
  trimJsonl(DRILL_RECEIPTS_PATH, policy.restore_drill.max_history);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && out.ok !== true) process.exitCode = 1;
  return out;
}

function cmdList(args: AnyObj): AnyObj {
  const policy = loadPolicy(args.policy);
  const profile = normalizeText(args.profile || policy.default_profile, 120) || 'runtime_state';
  const offsiteDest = resolveDestination(args['offsite-dest'] || args.offsite_dest, policy.offsite.destination_env, policy.offsite.destination_default);
  const limit = clampInt(args.limit, 1, 200, 20);
  const profileDir = path.join(offsiteDest, profile);
  const ids = listSnapshotIds(profileDir).reverse().slice(0, limit);
  const rows = ids.map((snapshotId: string) => {
    const manifestPath = path.join(profileDir, snapshotId, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, null);
    return {
      snapshot_id: snapshotId,
      manifest_path: manifestPath,
      ts: manifest && manifest.ts ? String(manifest.ts) : null,
      file_count: manifest && Number.isFinite(Number(manifest.file_count))
        ? Number(manifest.file_count)
        : null,
      total_plain_bytes: manifest && Number.isFinite(Number(manifest.total_plain_bytes))
        ? Number(manifest.total_plain_bytes)
        : null
    };
  });
  return {
    ok: true,
    type: 'offsite_backup_list',
    ts: nowIso(),
    profile,
    offsite_destination: offsiteDest,
    count: rows.length,
    snapshots: rows
  };
}

function cmdStatus(args: AnyObj): AnyObj {
  const policy = loadPolicy(args.policy);
  const profile = normalizeText(args.profile || policy.default_profile, 120) || 'runtime_state';
  const offsiteDest = resolveDestination(args['offsite-dest'] || args.offsite_dest, policy.offsite.destination_env, policy.offsite.destination_default);
  const profileDir = path.join(offsiteDest, profile);
  const snapshotCount = listSnapshotIds(profileDir).length;
  const syncRows = readJsonl(SYNC_RECEIPTS_PATH).filter((row) => String(row && row.profile || '') === profile);
  const drillRows = readJsonl(DRILL_RECEIPTS_PATH).filter((row) => String(row && row.profile || '') === profile);
  const lastSync = syncRows.length ? syncRows[syncRows.length - 1] : null;
  const lastDrill = drillRows.length ? drillRows[drillRows.length - 1] : null;
  const keyState = loadEncryptionKey(policy);
  const lastDrillMs = parseDateMs(lastDrill && lastDrill.ts);
  const cadenceMs = Number(policy.restore_drill.cadence_days || 30) * 86400000;
  const nowMs = Date.now();
  const nextDueMs = lastDrillMs == null ? nowMs : (lastDrillMs + cadenceMs);
  const lastSyncOk = lastSync && typeof lastSync.ok === 'boolean' ? lastSync.ok : null;
  const lastDrillOk = lastDrill && typeof lastDrill.ok === 'boolean' ? lastDrill.ok : null;
  const lastSyncReason = normalizeText(lastSync && (lastSync.reason || (Array.isArray(lastSync.reasons) ? lastSync.reasons[0] : '')), 180) || null;
  const lastDrillReasons = Array.isArray(lastDrill && lastDrill.reasons)
    ? (lastDrill.reasons as unknown[]).map((row) => normalizeText(row, 120)).filter(Boolean).slice(0, 8)
    : [];
  return {
    ok: true,
    type: 'offsite_backup_status',
    ts: nowIso(),
    profile,
    offsite_destination: offsiteDest,
    snapshots: snapshotCount,
    last_sync_ts: lastSync && lastSync.ts ? String(lastSync.ts) : null,
    last_sync_ok: lastSyncOk,
    last_sync_reason: lastSyncReason,
    last_drill_ts: lastDrill && lastDrill.ts ? String(lastDrill.ts) : null,
    last_drill_ok: lastDrillOk,
    last_drill_reasons: lastDrillReasons,
    restore_drill_due: nowMs >= nextDueMs,
    restore_drill_next_due_ts: new Date(nextDueMs).toISOString(),
    restore_drill_cadence_days: Number(policy.restore_drill.cadence_days || 30),
    encryption_key_ready: keyState.ok === true,
    encryption_key_env: keyState.key_env || null,
    encryption_key_reason: keyState.ok === true ? null : (keyState.reason || 'offsite_encryption_key_missing_or_invalid'),
    ready_for_sync: keyState.ok === true,
    ready_for_restore_drill: keyState.ok === true && snapshotCount > 0,
    remediation_hint: keyState.ok === true
      ? null
      : `Set ${String(keyState.key_env || policy.encryption.key_env || 'STATE_BACKUP_OFFSITE_KEY')} and rerun`
  };
}

function cmdDiagnose(args: AnyObj): AnyObj {
  const policy = loadPolicy(args.policy);
  const profile = normalizeText(args.profile || policy.default_profile, 120) || 'runtime_state';
  const limit = clampInt(args.limit, 1, 200, 20);
  const syncRows = readJsonl(SYNC_RECEIPTS_PATH).filter((row) => String(row && row.profile || '') === profile);
  const drillRows = readJsonl(DRILL_RECEIPTS_PATH).filter((row) => String(row && row.profile || '') === profile);
  const syncFail = syncRows.filter((row) => row && row.ok === false).slice(-limit);
  const drillFail = drillRows.filter((row) => row && row.ok === false).slice(-limit);
  const keyState = loadEncryptionKey(policy);
  return {
    ok: true,
    type: 'offsite_backup_diagnose',
    ts: nowIso(),
    profile,
    key_state: {
      ok: keyState.ok === true,
      env: keyState.key_env || null,
      reason: keyState.ok === true ? null : (keyState.reason || 'offsite_encryption_key_missing_or_invalid')
    },
    failures: {
      sync: syncFail.map((row) => ({
        ts: row.ts || null,
        reason: row.reason || null,
        strict: row.strict === true
      })),
      restore_drill: drillFail.map((row) => ({
        ts: row.ts || null,
        reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 8) : (row.reason ? [row.reason] : []),
        strict: row.strict === true
      }))
    },
    receipt_paths: {
      sync: path.relative(ROOT, SYNC_RECEIPTS_PATH).replace(/\\/g, '/'),
      restore_drill: path.relative(ROOT, DRILL_RECEIPTS_PATH).replace(/\\/g, '/')
    }
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 120).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }

  let out: AnyObj;
  if (cmd === 'sync') out = cmdSync(args);
  else if (cmd === 'restore-drill') out = cmdRestoreDrill(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else if (cmd === 'diagnose') out = cmdDiagnose(args);
  else if (cmd === 'list') out = cmdList(args);
  else {
    usage();
    process.exitCode = 2;
    return;
  }

  if (cmd === 'status' || cmd === 'list' || cmd === 'diagnose') {
    process.stdout.write(JSON.stringify(out) + '\n');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && (err as any).message ? (err as any).message : err || 'offsite_backup_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  parseArgs
};

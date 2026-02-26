#!/usr/bin/env node
'use strict';

/**
 * backup_integrity_check.js
 *
 * Verify backup snapshot integrity for state backups and blank-slate archives.
 *
 * Usage:
 *   node systems/ops/backup_integrity_check.js run [--channel=state_backup|blank_slate|all] [--snapshot=<id>] [--strict]
 *   node systems/ops/backup_integrity_check.js list [--channel=state_backup|blank_slate|all] [--limit=N]
 *   node systems/ops/backup_integrity_check.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.BACKUP_INTEGRITY_POLICY_PATH
  ? path.resolve(process.env.BACKUP_INTEGRITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'backup_integrity_policy.json');
const AUDIT_PATH = process.env.BACKUP_INTEGRITY_AUDIT_PATH
  ? path.resolve(process.env.BACKUP_INTEGRITY_AUDIT_PATH)
  : path.join(ROOT, 'state', 'ops', 'backup_integrity.jsonl');

/**
 * @typedef {{
 *   channels: Record<string, {
 *     destination_env?: string,
 *     destination_default?: string,
 *     profile?: string,
 *     manifest_type?: string,
 *     max_files?: number,
 *     required?: boolean
 *   }>,
 *   defaultChannels: string[]
 * }} BackupIntegrityPolicy
 */

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backup_integrity_check.js run [--channel=state_backup|blank_slate|all] [--snapshot=<id>] [--strict]');
  console.log('  node systems/ops/backup_integrity_check.js list [--channel=state_backup|blank_slate|all] [--limit=N]');
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

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean);
}

/**
 * @returns {BackupIntegrityPolicy}
 */
function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  const channels = raw && typeof raw.channels === 'object' ? raw.channels : {};
  const defaultChannels = normalizeArray(raw.default_channels);
  return { channels, defaultChannels };
}

function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return s;
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function resolveDest(channelCfg) {
  const envKey = String(channelCfg.destination_env || '').trim();
  const fromEnv = envKey ? String(process.env[envKey] || '').trim() : '';
  const fallback = expandHome(channelCfg.destination_default || '');
  const selected = fromEnv || fallback;
  if (!selected) return '';
  return path.resolve(selected);
}

function resolveChannels(policy, requested) {
  const keys = Object.keys(policy.channels || {}).sort();
  if (!requested || requested === 'all') return keys;
  if (policy.channels && policy.channels[requested]) return [requested];
  return [];
}

function listSnapshots(dest, profile, limit) {
  const profileDir = path.join(dest, profile);
  if (!fs.existsSync(profileDir)) return [];
  return fs.readdirSync(profileDir)
    .filter((id) => {
      const snapshotDir = path.join(profileDir, id);
      const manifestPath = path.join(snapshotDir, 'manifest.json');
      try {
        return fs.statSync(snapshotDir).isDirectory() && fs.existsSync(manifestPath);
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, limit);
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyStateBackupSnapshot(snapshotDir, manifest, maxFiles) {
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const subset = files.slice(0, Math.max(1, Math.min(Number(maxFiles || 2000), 20000)));
  let checked = 0;
  let missing = 0;
  let mismatch = 0;
  const failures = [];

  for (const row of subset) {
    const rel = String(row && row.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const target = path.join(snapshotDir, rel);
    if (!fs.existsSync(target)) {
      missing += 1;
      failures.push({ path: rel, reason: 'missing_file' });
      continue;
    }
    const st = fs.statSync(target);
    if (!st.isFile()) {
      missing += 1;
      failures.push({ path: rel, reason: 'not_file' });
      continue;
    }
    checked += 1;
    const expected = String(row && row.sha256 || '').trim().toLowerCase();
    if (!expected) continue;
    const actual = sha256File(target);
    if (actual !== expected) {
      mismatch += 1;
      failures.push({ path: rel, reason: 'sha_mismatch' });
    }
  }

  return {
    checked,
    missing,
    mismatch,
    ok: missing === 0 && mismatch === 0,
    failures: failures.slice(0, 50)
  };
}

function verifyBlankSlateSnapshot(snapshotDir, manifest, maxFiles) {
  const items = Array.isArray(manifest && manifest.items) ? manifest.items : [];
  const subset = items
    .filter((it) => it && it.moved === true)
    .slice(0, Math.max(1, Math.min(Number(maxFiles || 4000), 30000)));

  let checked = 0;
  let missing = 0;
  const failures = [];

  for (const row of subset) {
    const rel = String(row && row.archive_rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const target = path.join(snapshotDir, rel);
    checked += 1;
    if (!fs.existsSync(target)) {
      missing += 1;
      failures.push({ path: rel, reason: 'missing_payload' });
    }
  }

  return {
    checked,
    missing,
    mismatch: 0,
    ok: missing === 0,
    failures: failures.slice(0, 50)
  };
}

function verifyOffsiteEncryptedSnapshot(snapshotDir, manifest, maxFiles) {
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const subset = files.slice(0, Math.max(1, Math.min(Number(maxFiles || 2000), 50000)));
  let checked = 0;
  let missing = 0;
  let mismatch = 0;
  const failures = [];

  for (const row of subset) {
    const rel = String(row && row.encrypted_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const target = path.join(snapshotDir, rel);
    if (!fs.existsSync(target)) {
      missing += 1;
      failures.push({ path: rel, reason: 'missing_encrypted_payload' });
      continue;
    }
    const st = fs.statSync(target);
    if (!st.isFile()) {
      missing += 1;
      failures.push({ path: rel, reason: 'not_file' });
      continue;
    }
    checked += 1;
    const expected = String(row && row.encrypted_sha256 || '').trim().toLowerCase();
    if (!expected) continue;
    const actual = sha256File(target);
    if (actual !== expected) {
      mismatch += 1;
      failures.push({ path: rel, reason: 'sha_mismatch' });
    }
  }

  return {
    checked,
    missing,
    mismatch,
    ok: missing === 0 && mismatch === 0,
    failures: failures.slice(0, 50)
  };
}

function verifyChannel(policy, channelId, args) {
  const cfg = policy.channels[channelId];
  if (!cfg || typeof cfg !== 'object') {
    return {
      channel: channelId,
      ok: false,
      reason: 'channel_not_configured',
      required: false
    };
  }

  const dest = resolveDest(cfg);
  const profile = String(cfg.profile || '').trim();
  const manifestType = String(cfg.manifest_type || '').trim();
  const required = cfg.required === true;

  if (!dest || !profile) {
    return {
      channel: channelId,
      ok: !required,
      reason: 'destination_or_profile_missing',
      required,
      destination: dest || null,
      profile
    };
  }

  const ids = listSnapshots(dest, profile, 200);
  const requestedSnapshot = String(args.snapshot || '').trim();
  const selectedId = requestedSnapshot || (ids.length ? ids[0] : '');
  if (!selectedId) {
    return {
      channel: channelId,
      ok: !required,
      reason: 'no_snapshots',
      required,
      destination: dest,
      profile,
      snapshots: 0
    };
  }

  const snapshotDir = path.join(dest, profile, selectedId);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') {
    return {
      channel: channelId,
      ok: false,
      reason: 'manifest_missing_or_invalid',
      required,
      destination: dest,
      profile,
      snapshot_id: selectedId,
      manifest_path: manifestPath
    };
  }

  const actualType = String(manifest.type || '').trim();
  if (manifestType && actualType && actualType !== manifestType) {
    return {
      channel: channelId,
      ok: false,
      reason: 'manifest_type_mismatch',
      required,
      destination: dest,
      profile,
      snapshot_id: selectedId,
      expected_manifest_type: manifestType,
      actual_manifest_type: actualType
    };
  }

  const maxFiles = Number(cfg.max_files || 2000);
  let verification;
  if (actualType === 'blank_slate_reset_snapshot') {
    verification = verifyBlankSlateSnapshot(snapshotDir, manifest, maxFiles);
  } else if (actualType === 'offsite_encrypted_snapshot') {
    verification = verifyOffsiteEncryptedSnapshot(snapshotDir, manifest, maxFiles);
  } else {
    verification = verifyStateBackupSnapshot(snapshotDir, manifest, maxFiles);
  }

  return {
    channel: channelId,
    ok: verification.ok,
    reason: verification.ok ? 'verified' : 'integrity_failures',
    required,
    destination: dest,
    profile,
    snapshot_id: selectedId,
    manifest_type: actualType || null,
    verified_files: verification.checked,
    missing_files: verification.missing,
    hash_mismatches: verification.mismatch,
    failures: verification.failures
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const requested = String(args.channel || 'all').trim();
  const channels = resolveChannels(policy, requested);
  if (!channels.length) {
    return {
      ok: false,
      error: 'no_channels_selected',
      requested
    };
  }

  const rows = channels.map((ch) => verifyChannel(policy, ch, args));
  const strict = args.strict === true;
  const failedRequired = rows.filter((r) => r.required === true && r.ok !== true).length;
  const failedAny = rows.filter((r) => r.ok !== true).length;
  const ok = strict ? failedAny === 0 : failedRequired === 0;

  const out = {
    ok,
    ts: nowIso(),
    type: 'backup_integrity_check',
    strict,
    requested,
    checked_channels: rows.length,
    failed_channels: failedAny,
    failed_required_channels: failedRequired,
    channels: rows
  };

  appendJsonl(AUDIT_PATH, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    strict: out.strict,
    checked_channels: out.checked_channels,
    failed_channels: out.failed_channels,
    failed_required_channels: out.failed_required_channels
  });

  return out;
}

function cmdList(args) {
  const policy = loadPolicy();
  const requested = String(args.channel || 'all').trim();
  const channels = resolveChannels(policy, requested);
  const limitRaw = Number(args.limit || 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 100) : 10;

  const rows = channels.map((channelId) => {
    const cfg = policy.channels[channelId] || {};
    const dest = resolveDest(cfg);
    const profile = String(cfg.profile || '').trim();
    const ids = dest && profile ? listSnapshots(dest, profile, limit) : [];
    return {
      channel: channelId,
      destination: dest || null,
      profile: profile || null,
      snapshots: ids
    };
  });

  return {
    ok: true,
    ts: nowIso(),
    type: 'backup_integrity_list',
    requested,
    channels: rows
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }

  let out;
  if (cmd === 'run') out = cmdRun(args);
  else if (cmd === 'list') out = cmdList(args);
  else {
    usage();
    process.exitCode = 2;
    return;
  }

  process.stdout.write(JSON.stringify(out) + '\n');
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : err;
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(msg || 'backup_integrity_check_failed')
    }) + '\n');
    process.exit(1);
  }
}
export {};

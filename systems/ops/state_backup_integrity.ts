#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-007
 * Backup integrity checks for state backup snapshots.
 *
 * Usage:
 *   node systems/ops/state_backup_integrity.js check [--strict=1|0] [--limit=N] [--policy=<path>]
 *   node systems/ops/state_backup_integrity.js status [--policy=<path>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.STATE_BACKUP_INTEGRITY_ROOT
  ? path.resolve(process.env.STATE_BACKUP_INTEGRITY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STATE_BACKUP_INTEGRITY_POLICY_PATH
  ? path.resolve(process.env.STATE_BACKUP_INTEGRITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'state_backup_integrity_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
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
  const x = Math.floor(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function fileSha256(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    profile: 'runtime_state',
    destination: path.join(os.homedir(), '.openclaw', 'backups', 'workspace-state'),
    verify_recent_snapshots: 7,
    alert_on_mismatch: true,
    paths: {
      latest_path: 'state/ops/state_backup_integrity/latest.json',
      history_path: 'state/ops/state_backup_integrity/history.jsonl',
      alerts_path: 'state/ops/state_backup_integrity/alerts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    profile: cleanText(raw.profile || base.profile, 80) || base.profile,
    destination: resolvePath(raw.destination || base.destination, base.destination),
    verify_recent_snapshots: clampInt(raw.verify_recent_snapshots, 1, 500, base.verify_recent_snapshots),
    alert_on_mismatch: raw.alert_on_mismatch !== false,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      alerts_path: resolvePath(paths.alerts_path, base.paths.alerts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function listSnapshotIds(profileDir: string) {
  if (!fs.existsSync(profileDir)) return [];
  return fs.readdirSync(profileDir)
    .filter((name) => {
      const abs = path.join(profileDir, name);
      try {
        return fs.statSync(abs).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

function verifySnapshot(profileDir: string, snapshotId: string) {
  const snapDir = path.join(profileDir, snapshotId);
  const manifestPath = path.join(snapDir, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.files)) {
    return {
      snapshot_id: snapshotId,
      ok: false,
      error: 'manifest_missing_or_invalid',
      mismatch_count: 1,
      mismatches: [{ type: 'manifest_missing_or_invalid' }]
    };
  }

  const mismatches: AnyObj[] = [];
  for (const row of manifest.files) {
    const relPath = cleanText(row && row.path, 600).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relPath || relPath.includes('..')) {
      mismatches.push({ path: relPath || null, type: 'invalid_manifest_path' });
      continue;
    }
    const abs = path.join(snapDir, relPath);
    if (!fs.existsSync(abs)) {
      mismatches.push({ path: relPath, type: 'missing_file' });
      continue;
    }
    const expected = cleanText(row && row.sha256, 128).toLowerCase();
    const actual = fileSha256(abs).toLowerCase();
    if (!expected || expected !== actual) {
      mismatches.push({ path: relPath, type: 'sha256_mismatch', expected: expected || null, actual });
    }
  }

  const expectedCount = Number(manifest.file_count || 0);
  if (Number.isFinite(expectedCount) && expectedCount !== manifest.files.length) {
    mismatches.push({ type: 'manifest_file_count_mismatch', expected: expectedCount, actual: manifest.files.length });
  }

  return {
    snapshot_id: snapshotId,
    ok: mismatches.length === 0,
    mismatch_count: mismatches.length,
    mismatches
  };
}

function cmdCheck(args: Record<string, any>) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const strict = toBool(args.strict, true);
  const policy = loadPolicy(policyPath);
  const limit = clampInt(args.limit, 1, 500, policy.verify_recent_snapshots);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const profileDir = path.join(policy.destination, policy.profile);
  const ids = listSnapshotIds(profileDir).slice(0, limit);
  const checks = ids.map((id) => verifySnapshot(profileDir, id));
  const failed = checks.filter((row) => row.ok !== true);

  const out = {
    ok: failed.length === 0,
    ts: nowIso(),
    type: 'state_backup_integrity_check',
    strict,
    profile: policy.profile,
    destination: policy.destination,
    snapshots_checked: checks.length,
    failed_snapshots: failed.length,
    checks,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    strict,
    snapshots_checked: out.snapshots_checked,
    failed_snapshots: out.failed_snapshots,
    ok: out.ok
  });

  if (policy.alert_on_mismatch === true && failed.length > 0) {
    appendJsonl(policy.paths.alerts_path, {
      ts: out.ts,
      type: 'state_backup_integrity_alert',
      profile: policy.profile,
      destination: policy.destination,
      failed_snapshots: failed.map((row) => row.snapshot_id),
      mismatch_total: failed.reduce((acc, row) => acc + Number(row.mismatch_count || 0), 0)
    });
  }

  return out;
}

function cmdStatus(args: Record<string, any>) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'state_backup_integrity_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    alerts_path: rel(policy.paths.alerts_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_backup_integrity.js check [--strict=1|0] [--limit=N] [--policy=<path>]');
  console.log('  node systems/ops/state_backup_integrity.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'check'
      ? cmdCheck(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'check' && toBool(args.strict, true) && out.ok !== true) process.exit(1);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 420) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  verifySnapshot,
  cmdCheck,
  cmdStatus
};

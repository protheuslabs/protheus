#!/usr/bin/env node
'use strict';

/**
 * openclaw_backup_retention.js
 *
 * Retains recent OpenClaw config backups and archives older snapshots.
 *
 * Usage:
 *   node systems/ops/openclaw_backup_retention.js run [--root=<abs_path>] [--keep=N] [--dry-run]
 *   node systems/ops/openclaw_backup_retention.js status [--root=<abs_path>] [--keep=N]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ROOT = path.join(os.homedir(), '.openclaw');
const BAK_PREFIX = 'openclaw.json.bak';

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/openclaw_backup_retention.js run [--root=<abs_path>] [--keep=N] [--dry-run]');
  console.log('  node systems/ops/openclaw_backup_retention.js status [--root=<abs_path>] [--keep=N]');
}

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

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replace(/[:.]/g, '-');
}

function toAbs(v) {
  return path.resolve(String(v || '').trim());
}

function resolveRoot(args) {
  const fromArg = String(args.root || '').trim();
  const fromEnv = String(process.env.OPENCLAW_BACKUP_ROOT || '').trim();
  const root = toAbs(fromArg || fromEnv || DEFAULT_ROOT);
  if (!path.isAbsolute(root)) throw new Error('root must be absolute');
  return root;
}

function resolveKeep(args) {
  const raw = Number(args.keep || process.env.OPENCLAW_BACKUP_KEEP || 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(500, Math.floor(raw)));
}

function listBackupRows(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const rows = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(BAK_PREFIX)) continue;
    const full = path.join(root, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    rows.push({
      name,
      path: full,
      mtime_ms: Number(st.mtimeMs || 0),
      size_bytes: Number(st.size || 0)
    });
  }
  rows.sort((a, b) => {
    if (b.mtime_ms !== a.mtime_ms) return b.mtime_ms - a.mtime_ms;
    return String(a.name).localeCompare(String(b.name));
  });
  return rows;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function moveSafe(src, dst) {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
  }
  fs.copyFileSync(src, dst);
  fs.unlinkSync(src);
}

function summary(root, keep, rows) {
  const total = rows.length;
  const kept = Math.min(total, keep);
  const moveCount = Math.max(0, total - kept);
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
  return {
    root,
    keep_count: keep,
    total_backups: total,
    retained_count: kept,
    archive_count: moveCount,
    total_bytes: totalBytes
  };
}

function cmdStatus(args) {
  const root = resolveRoot(args);
  const keep = resolveKeep(args);
  const rows = listBackupRows(root);
  const sums = summary(root, keep, rows);
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    ...sums,
    newest: rows.length ? rows[0].name : null,
    oldest: rows.length ? rows[rows.length - 1].name : null
  }, null, 2) + '\n');
}

function cmdRun(args) {
  const root = resolveRoot(args);
  const keep = resolveKeep(args);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const rows = listBackupRows(root);
  const sums = summary(root, keep, rows);
  const toArchive = rows.slice(keep);
  const archiveDir = path.join(root, 'backup_archive', `openclaw_json_${stamp()}`);

  let moved = 0;
  if (!dryRun && toArchive.length) {
    ensureDir(archiveDir);
    for (const row of toArchive) {
      moveSafe(row.path, path.join(archiveDir, row.name));
      moved++;
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    dry_run: dryRun,
    ...sums,
    moved_count: dryRun ? toArchive.length : moved,
    archive_dir: toArchive.length ? archiveDir : null
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'run') return cmdRun(args);

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};

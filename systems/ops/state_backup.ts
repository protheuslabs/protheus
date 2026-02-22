#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * state_backup.js - deterministic external backup for runtime state.
 *
 * Usage:
 *   node systems/ops/state_backup.js run [--date=YYYY-MM-DD] [--profile=<id>] [--dest=<abs_path>] [--dry-run] [--prune]
 *   node systems/ops/state_backup.js list [--profile=<id>] [--dest=<abs_path>] [--limit=N]
 *   node systems/ops/state_backup.js --help
 *
 * Env:
 *   STATE_BACKUP_DEST=/absolute/path
 *   STATE_BACKUP_PROFILE=<id>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = path.join(ROOT, 'config', 'state_backup_policy.json');

function usage() {
  console.log('state_backup.js - runtime state backup');
  console.log('');
  console.log('Commands:');
  console.log('  run [--date=YYYY-MM-DD] [--profile=<id>] [--dest=<abs_path>] [--dry-run] [--prune]');
  console.log('  list [--profile=<id>] [--dest=<abs_path>] [--limit=N]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeRelPath(p) {
  const rel = String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return '';
  if (rel === '.' || rel.includes('..')) {
    throw new Error(`invalid relative path in backup policy: ${p}`);
  }
  return rel;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = normalizeRelPath(item);
    if (s) out.push(s);
  }
  return out;
}

function asSuffixArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = String(item || '').trim();
    if (s) out.push(s);
  }
  return out;
}

function loadPolicy(profileId) {
  const raw = readJsonSafe(POLICY_PATH, {});
  const profiles = raw && typeof raw.profiles === 'object' ? raw.profiles : {};
  const id = String(profileId || process.env.STATE_BACKUP_PROFILE || raw.default_profile || 'runtime_state').trim();
  const profile = profiles[id];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`backup profile not found: ${id}`);
  }
  const includes = asStringArray(profile.includes);
  if (!includes.length) throw new Error(`backup profile has no includes: ${id}`);
  const excludePrefixes = asStringArray(profile.exclude_prefixes);
  const excludeSuffixes = asSuffixArray(profile.exclude_suffixes);
  const maxSnapshots = Number(
    profile
    && profile.retention
    && profile.retention.max_snapshots
  );
  return {
    id,
    includes,
    exclude_prefixes: excludePrefixes,
    exclude_suffixes: excludeSuffixes,
    retention: {
      max_snapshots: Number.isFinite(maxSnapshots) && maxSnapshots > 0 ? Math.round(maxSnapshots) : 21
    }
  };
}

function resolveDest(args) {
  const fromArg = String(args.dest || '').trim();
  const fromEnv = String(process.env.STATE_BACKUP_DEST || '').trim();
  const fallback = path.join(os.homedir(), '.openclaw', 'backups', 'workspace-state');
  const dest = path.resolve(fromArg || fromEnv || fallback);
  if (!path.isAbsolute(dest)) throw new Error('backup destination must be absolute');
  return dest;
}

function relPath(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function isInsideRoot(absPath) {
  const rel = relPath(absPath);
  return !!rel && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function shouldExclude(rel, profile) {
  const p = String(rel || '').replace(/\\/g, '/');
  for (const pref of profile.exclude_prefixes || []) {
    if (!pref) continue;
    if (p === pref || p.startsWith(`${pref}/`)) return true;
  }
  for (const suffix of profile.exclude_suffixes || []) {
    if (!suffix) continue;
    if (p.endsWith(suffix)) return true;
  }
  return false;
}

function collectIncludedFiles(profile) {
  const files = [];
  const missing = [];
  const seen = new Set();

  for (const rel of profile.includes) {
    const abs = path.join(ROOT, rel);
    if (!isInsideRoot(abs)) continue;
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }

    const st = fs.statSync(abs);
    if (st.isFile()) {
      const itemRel = relPath(abs);
      if (!shouldExclude(itemRel, profile) && !seen.has(itemRel)) {
        seen.add(itemRel);
        files.push(itemRel);
      }
      continue;
    }
    if (!st.isDirectory()) continue;

    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      const entries = fs.readdirSync(cur, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        const itemRel = relPath(full);
        if (!itemRel || itemRel.startsWith('../')) continue;
        if (shouldExclude(itemRel, profile)) continue;
        if (ent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        if (seen.has(itemRel)) continue;
        seen.add(itemRel);
        files.push(itemRel);
      }
    }
  }

  files.sort();
  missing.sort();
  return { files, missing_includes: missing };
}

function fileSha256(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function snapshotStamp(dateArg) {
  const now = new Date();
  const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateArg || ''))
    ? String(dateArg)
    : now.toISOString().slice(0, 10);
  const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${baseDate.replace(/-/g, '')}T${hhmmss}Z`;
}

function listSnapshotIds(profileDir) {
  if (!fs.existsSync(profileDir)) return [];
  return fs.readdirSync(profileDir)
    .filter((name) => {
      const full = path.join(profileDir, name);
      try {
        return fs.statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function writeIndex(profileDir, row) {
  const fp = path.join(profileDir, 'index.jsonl');
  fs.appendFileSync(fp, `${JSON.stringify(row)}\n`, 'utf8');
}

function pruneOldSnapshots(profileDir, maxSnapshots) {
  const ids = listSnapshotIds(profileDir);
  const overflow = Math.max(0, ids.length - Math.max(1, Number(maxSnapshots || 1)));
  const pruneIds = overflow > 0 ? ids.slice(0, overflow) : [];
  for (const id of pruneIds) {
    const full = path.join(profileDir, id);
    fs.rmSync(full, { recursive: true, force: true });
  }
  return pruneIds;
}

function cmdRun(args) {
  const profile = loadPolicy(args.profile);
  const dest = resolveDest(args);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const prune = args.prune === true;
  const stamp = snapshotStamp(args.date);
  const profileDir = path.join(dest, profile.id);
  const snapshotDir = path.join(profileDir, stamp);

  const collected = collectIncludedFiles(profile);
  const entries = [];
  let totalBytes = 0;

  for (const rel of collected.files) {
    const src = path.join(ROOT, rel);
    const st = fs.statSync(src);
    const entry = {
      path: rel,
      size_bytes: Number(st.size || 0),
      mtime_ms: Number(st.mtimeMs || 0),
      sha256: fileSha256(src)
    };
    entries.push(entry);
    totalBytes += entry.size_bytes;
  }

  if (!dryRun) {
    ensureDir(snapshotDir);
    for (const ent of entries) {
      const src = path.join(ROOT, ent.path);
      const dst = path.join(snapshotDir, ent.path);
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
    }

    const manifest = {
      ts: new Date().toISOString(),
      type: 'state_backup_snapshot',
      profile: profile.id,
      source_root: ROOT,
      snapshot_id: stamp,
      file_count: entries.length,
      total_bytes: totalBytes,
      missing_includes: collected.missing_includes,
      files: entries
    };
    fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeIndex(profileDir, {
      ts: manifest.ts,
      profile: profile.id,
      snapshot_id: stamp,
      file_count: entries.length,
      total_bytes: totalBytes,
      missing_includes: collected.missing_includes
    });
  }

  const existingIds = listSnapshotIds(profileDir);
  const maxSnapshots = Number(profile.retention && profile.retention.max_snapshots || 21);
  const wouldPrune = Math.max(0, existingIds.length - Math.max(1, maxSnapshots));
  const pruned = (!dryRun && prune) ? pruneOldSnapshots(profileDir, maxSnapshots) : [];

  process.stdout.write(JSON.stringify({
    ok: true,
    dry_run: !!dryRun,
    profile: profile.id,
    destination: dest,
    snapshot_id: stamp,
    snapshot_dir: snapshotDir,
    file_count: entries.length,
    total_bytes: totalBytes,
    missing_includes: collected.missing_includes,
    retention: {
      max_snapshots: maxSnapshots,
      existing_snapshots: existingIds.length,
      prune_requested: !!prune,
      would_prune: wouldPrune,
      pruned
    }
  }) + '\n');
}

function cmdList(args) {
  const profile = loadPolicy(args.profile);
  const dest = resolveDest(args);
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.round(limitRaw) : 20;
  const profileDir = path.join(dest, profile.id);
  const ids = listSnapshotIds(profileDir).sort().reverse().slice(0, limit);
  const snapshots = ids.map((id) => {
    const manifestPath = path.join(profileDir, id, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, null);
    return {
      snapshot_id: id,
      manifest_path: manifestPath,
      file_count: manifest && Number.isFinite(Number(manifest.file_count))
        ? Number(manifest.file_count)
        : null,
      total_bytes: manifest && Number.isFinite(Number(manifest.total_bytes))
        ? Number(manifest.total_bytes)
        : null,
      ts: manifest && manifest.ts ? String(manifest.ts) : null
    };
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    profile: profile.id,
    destination: dest,
    count: snapshots.length,
    snapshots
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  try {
    if (cmd === 'run') return cmdRun(args);
    if (cmd === 'list') return cmdList(args);
    usage();
    process.exit(2);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'state_backup_failed')
    }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

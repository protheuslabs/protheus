#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * blank_slate_reset.js - reversible archive-based adaptive+memory reset.
 *
 * Safety defaults:
 * - run defaults to --dry-run
 * - apply requires --confirm=RESET
 * - no destructive delete; paths are moved to an archive snapshot
 *
 * Usage:
 *   node systems/ops/blank_slate_reset.js run [--profile=<id>] [--dest=<abs_path>] [--apply] [--dry-run] [--confirm=RESET]
 *   node systems/ops/blank_slate_reset.js rollback --id=<snapshot_id> [--profile=<id>] [--dest=<abs_path>] [--dry-run]
 *   node systems/ops/blank_slate_reset.js list [--profile=<id>] [--dest=<abs_path>] [--limit=N]
 *   node systems/ops/blank_slate_reset.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.BLANK_SLATE_ROOT || path.join(__dirname, '..', '..'));
const POLICY_PATH = path.resolve(process.env.BLANK_SLATE_POLICY || path.join(ROOT, 'config', 'blank_slate_reset_policy.json'));

function usage() {
  console.log('blank_slate_reset.js - reversible blank-slate reset');
  console.log('');
  console.log('Commands:');
  console.log('  run [--profile=<id>] [--dest=<abs_path>] [--apply] [--dry-run] [--confirm=RESET]');
  console.log('  rollback --id=<snapshot_id> [--profile=<id>] [--dest=<abs_path>] [--dry-run]');
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
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
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
    throw new Error(`invalid relative path: ${p}`);
  }
  return rel;
}

function resolveDest(args) {
  const fromArg = String(args.dest || '').trim();
  const fromEnv = String(process.env.BLANK_SLATE_DEST || '').trim();
  const fallback = path.join(os.homedir(), '.openclaw', 'backups', 'workspace-blank-slate');
  const dest = path.resolve(fromArg || fromEnv || fallback);
  if (!path.isAbsolute(dest)) throw new Error('blank slate destination must be absolute');
  return dest;
}

function relPath(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function isInsideRoot(absPath) {
  const rel = relPath(absPath);
  return !!rel && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function normalizeRelList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = normalizeRelPath(item);
    if (s) out.push(s);
  }
  return out;
}

function normalizeSuffixList(v) {
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
  const id = String(profileId || raw.default_profile || '').trim();
  if (!id) throw new Error('blank slate policy missing default_profile');
  const profile = profiles[id];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`blank slate profile not found: ${id}`);
  }
  const includes = normalizeRelList(profile.includes);
  if (!includes.length) throw new Error(`blank slate profile has no includes: ${id}`);
  return {
    id,
    includes,
    exclude_exact: new Set(normalizeRelList(profile.exclude_exact)),
    exclude_prefixes: normalizeRelList(profile.exclude_prefixes),
    exclude_suffixes: normalizeSuffixList(profile.exclude_suffixes)
  };
}

function wildcardToRegex(segment) {
  const escaped = segment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function expandIncludePattern(relPattern) {
  const p = normalizeRelPath(relPattern);
  if (!p.includes('*')) return [p];

  const dirRel = path.posix.dirname(p);
  const basePattern = path.posix.basename(p);
  if (!basePattern.includes('*')) return [p];
  if (dirRel.includes('*')) {
    throw new Error(`wildcards are only supported in the final segment: ${p}`);
  }

  const dirAbs = path.join(ROOT, dirRel === '.' ? '' : dirRel);
  if (!isInsideRoot(dirAbs) || !fs.existsSync(dirAbs)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }

  const re = wildcardToRegex(basePattern);
  const out = [];
  for (const ent of entries) {
    if (!re.test(ent.name)) continue;
    const rel = dirRel === '.' ? ent.name : `${dirRel}/${ent.name}`;
    out.push(rel);
  }
  return out;
}

function isExcluded(rel, profile) {
  const p = normalizeRelPath(rel);
  if (profile.exclude_exact.has(p)) return true;
  for (const pref of profile.exclude_prefixes) {
    if (p === pref || p.startsWith(`${pref}/`)) return true;
  }
  for (const suffix of profile.exclude_suffixes) {
    if (suffix && p.endsWith(suffix)) return true;
  }
  return false;
}

function compressParents(paths) {
  const sorted = Array.from(new Set(paths)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out = [];
  for (const p of sorted) {
    let covered = false;
    for (const parent of out) {
      if (p === parent || p.startsWith(`${parent}/`)) {
        covered = true;
        break;
      }
    }
    if (!covered) out.push(p);
  }
  return out.sort();
}

function collectTargets(profile) {
  const expanded = [];
  for (const item of profile.includes) {
    const items = expandIncludePattern(item);
    for (const rel of items) expanded.push(rel);
  }

  const filtered = [];
  const missing = [];
  for (const rel of expanded) {
    const norm = normalizeRelPath(rel);
    if (!norm || isExcluded(norm, profile)) continue;
    const abs = path.join(ROOT, norm);
    if (!isInsideRoot(abs) || !fs.existsSync(abs)) {
      missing.push(norm);
      continue;
    }
    filtered.push(norm);
  }

  const targets = compressParents(filtered);
  return { targets, missing_includes: Array.from(new Set(missing)).sort() };
}

function snapshotStamp() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(4).toString('hex');
  return `reset_${iso}_${nonce}`;
}

function movePath(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
  }

  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(src, dest);
  fs.rmSync(src, { force: true });
}

function writeManifest(snapshotDir, manifest) {
  ensureDir(snapshotDir);
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function appendIndex(profileDir, row) {
  ensureDir(profileDir);
  fs.appendFileSync(path.join(profileDir, 'index.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

function readManifest(profileDir, snapshotId) {
  const id = String(snapshotId || '').trim();
  if (!id) throw new Error('rollback requires --id=<snapshot_id>');
  const fp = path.join(profileDir, id, 'manifest.json');
  if (!fs.existsSync(fp)) throw new Error(`snapshot manifest not found: ${id}`);
  const manifest = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!manifest || manifest.type !== 'blank_slate_reset_snapshot') {
    throw new Error(`invalid snapshot manifest: ${id}`);
  }
  return manifest;
}

function cmdRun(args) {
  const profile = loadPolicy(args.profile);
  const destination = resolveDest(args);
  const apply = args.apply === true;
  const explicitDryRun = args['dry-run'] === true || args.dry_run === true;
  const dryRun = apply ? false : true;
  if (apply && String(args.confirm || '') !== 'RESET') {
    throw new Error('apply requires --confirm=RESET');
  }
  if (explicitDryRun) {
    // Keep deterministic precedence: explicit --dry-run always wins.
    if (apply) {
      throw new Error('cannot combine --apply and --dry-run');
    }
  }

  const { targets, missing_includes } = collectTargets(profile);
  const resetId = snapshotStamp();
  const profileDir = path.join(destination, profile.id);
  const snapshotDir = path.join(profileDir, resetId);

  const moved = [];
  const results = [];
  for (const rel of targets) {
    const src = path.join(ROOT, rel);
    const archiveRel = path.join('payload', rel).replace(/\\/g, '/');
    const archiveAbs = path.join(snapshotDir, archiveRel);

    const st = fs.statSync(src);
    const row = {
      path: rel,
      kind: st.isDirectory() ? 'dir' : 'file',
      bytes: st.isFile() ? Number(st.size || 0) : null,
      src,
      archive_rel: archiveRel,
      archive_abs: archiveAbs,
      moved: false
    };

    if (!dryRun) {
      movePath(src, archiveAbs);
      row.moved = true;
      moved.push(row);
    }
    results.push(row);
  }

  const now = new Date().toISOString();
  const manifest = {
    type: 'blank_slate_reset_snapshot',
    ts: now,
    id: resetId,
    profile: profile.id,
    root: ROOT,
    destination,
    dry_run: dryRun,
    missing_includes,
    items: results.map((r) => ({
      path: r.path,
      kind: r.kind,
      bytes: r.bytes,
      archive_rel: r.archive_rel,
      moved: r.moved
    }))
  };

  if (!dryRun) {
    writeManifest(snapshotDir, manifest);
    appendIndex(profileDir, {
      ts: now,
      type: 'blank_slate_reset',
      id: resetId,
      profile: profile.id,
      item_count: results.length,
      moved_count: moved.length,
      destination,
      snapshot_dir: snapshotDir
    });
  }

  return {
    ok: true,
    type: 'blank_slate_reset',
    profile: profile.id,
    destination,
    dry_run: dryRun,
    id: resetId,
    snapshot_dir: dryRun ? null : snapshotDir,
    item_count: results.length,
    moved_count: moved.length,
    missing_includes,
    items: results.map((r) => ({ path: r.path, kind: r.kind, moved: r.moved }))
  };
}

function cmdRollback(args) {
  const profile = loadPolicy(args.profile);
  const destination = resolveDest(args);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const profileDir = path.join(destination, profile.id);
  const manifest = readManifest(profileDir, args.id);

  const conflicts = [];
  const rows = [];
  for (const item of manifest.items || []) {
    if (!item || item.moved !== true) continue;
    const src = path.join(profileDir, manifest.id, item.archive_rel || '');
    const dest = path.join(ROOT, item.path || '');
    const srcExists = fs.existsSync(src);
    const destExists = fs.existsSync(dest);
    if (destExists) {
      conflicts.push(item.path || '');
    }
    rows.push({
      path: item.path,
      kind: item.kind,
      src,
      dest,
      src_exists: srcExists,
      dest_exists: destExists,
      moved_back: false
    });
  }

  if (conflicts.length) {
    return {
      ok: false,
      type: 'blank_slate_rollback',
      id: manifest.id,
      dry_run: dryRun,
      conflicts,
      reason: 'destination_conflict'
    };
  }

  let movedBack = 0;
  if (!dryRun) {
    for (const row of rows) {
      if (!row.src_exists) continue;
      movePath(row.src, row.dest);
      row.moved_back = true;
      movedBack += 1;
    }
    appendIndex(profileDir, {
      ts: new Date().toISOString(),
      type: 'blank_slate_rollback',
      id: manifest.id,
      profile: profile.id,
      moved_back: movedBack
    });
  }

  return {
    ok: true,
    type: 'blank_slate_rollback',
    id: manifest.id,
    profile: profile.id,
    dry_run: dryRun,
    moved_back: dryRun ? 0 : movedBack,
    item_count: rows.length,
    items: rows.map((r) => ({ path: r.path, moved_back: r.moved_back }))
  };
}

function cmdList(args) {
  const profile = loadPolicy(args.profile);
  const destination = resolveDest(args);
  const profileDir = path.join(destination, profile.id);
  const limitRaw = Number(args.limit || 20);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 200) : 20;

  if (!fs.existsSync(profileDir)) {
    return {
      ok: true,
      type: 'blank_slate_list',
      profile: profile.id,
      destination,
      snapshots: []
    };
  }

  const dirs = fs.readdirSync(profileDir)
    .filter((name) => {
      const full = path.join(profileDir, name);
      try {
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'manifest.json'));
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, limit);

  const snapshots = dirs.map((id) => {
    const manifest = readJsonSafe(path.join(profileDir, id, 'manifest.json'), {});
    return {
      id,
      ts: manifest.ts || null,
      profile: manifest.profile || profile.id,
      dry_run: manifest.dry_run === true,
      item_count: Array.isArray(manifest.items) ? manifest.items.length : 0
    };
  });

  return {
    ok: true,
    type: 'blank_slate_list',
    profile: profile.id,
    destination,
    snapshots
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || args.help === true) {
    usage();
    return;
  }

  let payload;
  if (cmd === 'run') payload = cmdRun(args);
  else if (cmd === 'rollback') payload = cmdRollback(args);
  else if (cmd === 'list') payload = cmdList(args);
  else {
    usage();
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

try {
  if (require.main === module) main();
} catch (err) {
  process.stderr.write(`${String(err && err.message || err || 'blank_slate_reset_failed')}\n`);
  process.exit(1);
}

module.exports = {
  cmdRun,
  cmdRollback,
  cmdList,
  loadPolicy,
  collectTargets
};

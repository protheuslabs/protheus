#!/usr/bin/env node
'use strict';

/**
 * anti_sabotage_shield.js
 *
 * Mutation provenance monitor + instant auto-reset to last attested snapshot.
 *
 * Usage:
 *   node systems/security/anti_sabotage_shield.js snapshot [--label=<id>]
 *   node systems/security/anti_sabotage_shield.js verify [--snapshot=latest|<id>] [--auto-reset=1|0] [--strict=1|0]
 *   node systems/security/anti_sabotage_shield.js watch [--snapshot=latest|<id>] [--auto-reset=1|0] [--strict=1|0] [--interval-ms=<n>] [--iterations=<n>] [--bootstrap-snapshot=1|0]
 *   node systems/security/anti_sabotage_shield.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ANTI_SABOTAGE_POLICY_PATH
  ? path.resolve(process.env.ANTI_SABOTAGE_POLICY_PATH)
  : path.join(ROOT, 'config', 'anti_sabotage_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/anti_sabotage_shield.js snapshot [--label=<id>]');
  console.log('  node systems/security/anti_sabotage_shield.js verify [--snapshot=latest|<id>] [--auto-reset=1|0] [--strict=1|0]');
  console.log('  node systems/security/anti_sabotage_shield.js watch [--snapshot=latest|<id>] [--auto-reset=1|0] [--strict=1|0] [--interval-ms=<n>] [--iterations=<n>] [--bootstrap-snapshot=1|0]');
  console.log('  node systems/security/anti_sabotage_shield.js status');
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

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function toBool(v, fallback) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    protected_roots: ['systems', 'config', 'lib', 'adaptive'],
    extensions: ['.js', '.ts', '.json', '.yaml', '.yml'],
    state_dir: 'state/security/anti_sabotage',
    quarantine_dir: 'state/security/anti_sabotage/quarantine',
    snapshots_dir: 'state/security/anti_sabotage/snapshots',
    incident_log: 'state/security/anti_sabotage/incidents.jsonl',
    state_file: 'state/security/anti_sabotage/state.json',
    watcher_state_file: 'state/security/anti_sabotage/watcher_state.json',
    watcher_interval_ms: 30000,
    max_snapshots: 20,
    max_snapshot_age_days: 14,
    watcher_strict_default: false,
    watcher_auto_reset_default: true,
    verify_strict_default: true,
    auto_reset_default: true
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const roots = Array.isArray(raw.protected_roots) && raw.protected_roots.length
    ? raw.protected_roots
    : base.protected_roots;
  const exts = Array.isArray(raw.extensions) && raw.extensions.length
    ? raw.extensions
    : base.extensions;
  const normalizeExt = (ext) => {
    const t = normalizeText(ext, 16).toLowerCase();
    if (!t) return '';
    return t.startsWith('.') ? t : `.${t}`;
  };
  return {
    version: normalizeText(raw.version || base.version, 32) || '1.0',
    protected_roots: roots.map((r) => normalizeText(r, 180)).filter(Boolean),
    extensions: exts.map(normalizeExt).filter(Boolean),
    state_dir: normalizeText(raw.state_dir || base.state_dir, 200) || base.state_dir,
    quarantine_dir: normalizeText(raw.quarantine_dir || base.quarantine_dir, 200) || base.quarantine_dir,
    snapshots_dir: normalizeText(raw.snapshots_dir || base.snapshots_dir, 200) || base.snapshots_dir,
    incident_log: normalizeText(raw.incident_log || base.incident_log, 200) || base.incident_log,
    state_file: normalizeText(raw.state_file || base.state_file, 200) || base.state_file,
    watcher_state_file: normalizeText(raw.watcher_state_file || base.watcher_state_file, 200) || base.watcher_state_file,
    watcher_interval_ms: Math.max(250, Number(raw.watcher_interval_ms || base.watcher_interval_ms || 30000)),
    max_snapshots: Math.max(1, Number(raw.max_snapshots || base.max_snapshots || 20)),
    max_snapshot_age_days: Math.max(1, Number(raw.max_snapshot_age_days || base.max_snapshot_age_days || 14)),
    watcher_strict_default: raw.watcher_strict_default === true,
    watcher_auto_reset_default: raw.watcher_auto_reset_default !== false,
    verify_strict_default: raw.verify_strict_default !== false,
    auto_reset_default: raw.auto_reset_default !== false
  };
}

function pruneSnapshots(policy) {
  const snapshotsRoot = path.resolve(ROOT, policy.snapshots_dir);
  if (!fs.existsSync(snapshotsRoot)) {
    return {
      pruned_for_age: 0,
      pruned_for_count: 0,
      remaining: 0
    };
  }
  const maxAgeDays = Math.max(1, Number(policy.max_snapshot_age_days || 14));
  const maxSnapshots = Math.max(1, Number(policy.max_snapshots || 20));
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((ent) => ent && ent.isDirectory())
      .map((ent) => {
        const abs = path.join(snapshotsRoot, ent.name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(abs).mtimeMs || 0);
        } catch {
          mtimeMs = 0;
        }
        return {
          id: ent.name,
          abs,
          mtimeMs
        };
      })
      .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));
  } catch {
    entries = [];
  }

  let prunedForAge = 0;
  for (const row of entries) {
    if ((nowMs - Number(row.mtimeMs || 0)) <= maxAgeMs) continue;
    try {
      fs.rmSync(row.abs, { recursive: true, force: true });
      prunedForAge += 1;
    } catch {}
  }

  entries = entries.filter((row) => fs.existsSync(row.abs));
  let prunedForCount = 0;
  while (entries.length > maxSnapshots) {
    const row = entries.shift();
    if (!row) break;
    try {
      fs.rmSync(row.abs, { recursive: true, force: true });
      prunedForCount += 1;
    } catch {}
  }

  return {
    pruned_for_age: prunedForAge,
    pruned_for_count: prunedForCount,
    remaining: entries.length
  };
}

function walkFiles(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function monitoredFiles(policy) {
  const out = [];
  const extSet = new Set(policy.extensions || []);
  for (const relRoot of policy.protected_roots || []) {
    const absRoot = path.resolve(ROOT, relRoot);
    for (const absFile of walkFiles(absRoot, [])) {
      const ext = path.extname(absFile).toLowerCase();
      if (extSet.size > 0 && !extSet.has(ext)) continue;
      out.push(absFile);
    }
  }
  out.sort((a, b) => relPath(a).localeCompare(relPath(b)));
  return out;
}

function snapshotId(label) {
  const ts = nowIso().replace(/[-:TZ.]/g, '').slice(0, 14);
  const cleanLabel = normalizeText(label || '', 80)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleanLabel ? `${ts}_${cleanLabel}` : ts;
}

function snapshotPaths(policy, id) {
  const snapshotsRoot = path.resolve(ROOT, policy.snapshots_dir);
  const snapDir = path.join(snapshotsRoot, id);
  return {
    snapshots_root: snapshotsRoot,
    snapshot_dir: snapDir,
    manifest_path: path.join(snapDir, 'manifest.json'),
    files_root: path.join(snapDir, 'files')
  };
}

function statePath(policy) {
  return path.resolve(ROOT, policy.state_file);
}

function incidentLogPath(policy) {
  return path.resolve(ROOT, policy.incident_log);
}

function watcherStatePath(policy) {
  return path.resolve(ROOT, policy.watcher_state_file || path.join(policy.state_dir || 'state/security/anti_sabotage', 'watcher_state.json'));
}

function saveWatcherState(policy, next = {}) {
  const out = {
    schema_id: 'anti_sabotage_watcher_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_verify_ts: normalizeText(next.last_verify_ts || '', 64) || null,
    last_snapshot_id: normalizeText(next.last_snapshot_id || '', 120) || null,
    iterations: Math.max(0, Number(next.iterations || 0)),
    violations: Math.max(0, Number(next.violations || 0)),
    recoveries: Math.max(0, Number(next.recoveries || 0)),
    last_incident_id: normalizeText(next.last_incident_id || '', 120) || null
  };
  writeJsonAtomic(watcherStatePath(policy), out);
}

function sleepMs(ms) {
  const waitMs = Math.max(0, Math.floor(Number(ms || 0)));
  if (waitMs <= 0) return;
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, waitMs);
}

function loadState(policy) {
  const state = readJson(statePath(policy), null);
  if (!state || typeof state !== 'object') {
    return {
      schema_id: 'anti_sabotage_state',
      schema_version: '1.0',
      latest_snapshot: null,
      latest_snapshot_manifest: null,
      latest_incident: null,
      updated_at: null
    };
  }
  return {
    schema_id: 'anti_sabotage_state',
    schema_version: '1.0',
    latest_snapshot: normalizeText(state.latest_snapshot || '', 120) || null,
    latest_snapshot_manifest: normalizeText(state.latest_snapshot_manifest || '', 240) || null,
    latest_incident: normalizeText(state.latest_incident || '', 120) || null,
    updated_at: normalizeText(state.updated_at || '', 64) || null
  };
}

function saveState(policy, next) {
  const out = {
    schema_id: 'anti_sabotage_state',
    schema_version: '1.0',
    latest_snapshot: next.latest_snapshot || null,
    latest_snapshot_manifest: next.latest_snapshot_manifest || null,
    latest_incident: next.latest_incident || null,
    updated_at: nowIso()
  };
  writeJsonAtomic(statePath(policy), out);
}

function copyFileTo(srcAbs, dstAbs) {
  ensureDir(path.dirname(dstAbs));
  fs.copyFileSync(srcAbs, dstAbs);
}

function createSnapshot(policy, label = '') {
  const id = snapshotId(label);
  const paths = snapshotPaths(policy, id);
  ensureDir(paths.files_root);
  const files = monitoredFiles(policy);
  const hashes = {};
  for (const absFile of files) {
    const rel = relPath(absFile);
    hashes[rel] = hashFile(absFile);
    copyFileTo(absFile, path.join(paths.files_root, rel));
  }
  const manifest = {
    schema_id: 'anti_sabotage_snapshot_manifest',
    schema_version: '1.0',
    snapshot_id: id,
    created_at: nowIso(),
    policy_version: policy.version,
    roots: policy.protected_roots,
    extensions: policy.extensions,
    file_count: files.length,
    hashes
  };
  writeJsonAtomic(paths.manifest_path, manifest);

  saveState(policy, {
    latest_snapshot: id,
    latest_snapshot_manifest: relPath(paths.manifest_path),
    latest_incident: loadState(policy).latest_incident || null
  });

  const prune = pruneSnapshots(policy);

  return {
    ok: true,
    type: 'anti_sabotage_snapshot',
    ts: nowIso(),
    snapshot_id: id,
    manifest_path: relPath(paths.manifest_path),
    file_count: files.length,
    policy_version: policy.version,
    prune
  };
}

function loadSnapshotManifest(policy, selector) {
  const state = loadState(policy);
  const selected = normalizeText(selector || '', 120).toLowerCase();
  const id = (!selected || selected === 'latest')
    ? state.latest_snapshot
    : selected;
  if (!id) return { ok: false, error: 'snapshot_not_found' };
  const paths = snapshotPaths(policy, id);
  const manifest = readJson(paths.manifest_path, null);
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'snapshot_manifest_missing', snapshot_id: id, manifest_path: relPath(paths.manifest_path) };
  }
  return {
    ok: true,
    snapshot_id: id,
    paths,
    manifest
  };
}

function evaluateSnapshot(policy, loaded) {
  const manifest = loaded.manifest;
  const expectedHashes = manifest && manifest.hashes && typeof manifest.hashes === 'object'
    ? manifest.hashes
    : {};
  const currentFiles = monitoredFiles(policy);
  const currentByRel = new Map();
  for (const abs of currentFiles) currentByRel.set(relPath(abs), abs);

  const mismatches = [];
  const missing = [];
  const extra = [];

  for (const [rel, expected] of Object.entries(expectedHashes)) {
    const abs = currentByRel.get(rel);
    if (!abs || !fs.existsSync(abs)) {
      missing.push({ file: rel });
      continue;
    }
    const actual = hashFile(abs);
    if (String(actual) !== String(expected)) {
      mismatches.push({ file: rel, expected, actual });
    }
  }

  for (const rel of currentByRel.keys()) {
    if (!Object.prototype.hasOwnProperty.call(expectedHashes, rel)) {
      extra.push({ file: rel });
    }
  }

  return {
    mismatches,
    missing,
    extra,
    violated: mismatches.length + missing.length + extra.length
  };
}

function restoreFromSnapshot(policy, loaded, evalOut) {
  const start = Date.now();
  const incidentId = `${loaded.snapshot_id}_${Date.now()}`;
  const quarantineRoot = path.resolve(ROOT, policy.quarantine_dir, incidentId);
  const restored = [];
  const quarantined = [];
  const deletedExtra = [];

  for (const row of evalOut.mismatches) {
    const rel = row.file;
    const absCurrent = path.resolve(ROOT, rel);
    const absSnapshot = path.join(loaded.paths.files_root, rel);
    if (fs.existsSync(absCurrent)) {
      copyFileTo(absCurrent, path.join(quarantineRoot, rel));
      quarantined.push(rel);
    }
    copyFileTo(absSnapshot, absCurrent);
    restored.push(rel);
  }

  for (const row of evalOut.missing) {
    const rel = row.file;
    const absCurrent = path.resolve(ROOT, rel);
    const absSnapshot = path.join(loaded.paths.files_root, rel);
    copyFileTo(absSnapshot, absCurrent);
    restored.push(rel);
  }

  for (const row of evalOut.extra) {
    const rel = row.file;
    const absCurrent = path.resolve(ROOT, rel);
    if (!fs.existsSync(absCurrent)) continue;
    copyFileTo(absCurrent, path.join(quarantineRoot, rel));
    quarantined.push(rel);
    try {
      fs.unlinkSync(absCurrent);
      deletedExtra.push(rel);
    } catch {
      // leave file if unlink fails
    }
  }

  return {
    incident_id: incidentId,
    quarantine_root: relPath(quarantineRoot),
    restored,
    quarantined,
    deleted_extra: deletedExtra,
    recovery_ms: Date.now() - start
  };
}

function cmdSnapshot(args) {
  const policy = loadPolicy();
  const out = createSnapshot(policy, args.label || 'manual');
  appendJsonl(incidentLogPath(policy), {
    ts: nowIso(),
    type: 'anti_sabotage_snapshot',
    snapshot_id: out.snapshot_id,
    manifest_path: out.manifest_path,
    file_count: out.file_count
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function runVerifyOnce(policy, opts = {}) {
  const strict = toBool(opts.strict, policy.verify_strict_default);
  const autoReset = toBool(opts.autoReset, policy.auto_reset_default);
  const bootstrapSnapshot = toBool(opts.bootstrapSnapshot, true);
  let loaded = loadSnapshotManifest(policy, opts.snapshot);
  let bootstrappedSnapshotId = null;
  if (!loaded.ok && loaded.error === 'snapshot_not_found' && autoReset && bootstrapSnapshot) {
    const snap = createSnapshot(policy, 'verify_bootstrap');
    bootstrappedSnapshotId = snap && snap.snapshot_id ? String(snap.snapshot_id) : null;
    loaded = loadSnapshotManifest(policy, bootstrappedSnapshotId || 'latest');
  }
  if (!loaded.ok) {
    return {
      ok: false,
      strict,
      auto_reset: autoReset,
      error: loaded,
      incident: null
    };
  }

  const evalOut = evaluateSnapshot(policy, loaded);
  const violated = evalOut.violated > 0;
  let recovery = null;
  if (violated && autoReset) {
    recovery = restoreFromSnapshot(policy, loaded, evalOut);
  }

  const incident = {
    ok: !violated || !!recovery,
    type: 'anti_sabotage_verify',
    source: normalizeText(opts.source || 'verify', 48) || 'verify',
    ts: nowIso(),
    snapshot_id: loaded.snapshot_id,
    strict,
    auto_reset: autoReset,
    bootstrap_snapshot_created: !!bootstrappedSnapshotId,
    bootstrap_snapshot_id: bootstrappedSnapshotId,
    violated,
    mismatch_count: evalOut.mismatches.length,
    missing_count: evalOut.missing.length,
    extra_count: evalOut.extra.length,
    mismatches: evalOut.mismatches,
    missing: evalOut.missing,
    extra: evalOut.extra,
    recovery
  };

  appendJsonl(incidentLogPath(policy), incident);
  if (recovery && recovery.incident_id) {
    saveState(policy, {
      latest_snapshot: loaded.snapshot_id,
      latest_snapshot_manifest: relPath(loaded.paths.manifest_path),
      latest_incident: recovery.incident_id
    });
  }

  return {
    ok: incident.ok,
    strict,
    auto_reset: autoReset,
    incident,
    loaded
  };
}

function cmdVerify(args) {
  const policy = loadPolicy();
  const result = runVerifyOnce(policy, {
    snapshot: args.snapshot,
    strict: args.strict,
    autoReset: args['auto-reset'] || args.auto_reset,
    bootstrapSnapshot: args['bootstrap-snapshot'] || args.bootstrap_snapshot,
    source: 'verify'
  });
  if (!result.incident) {
    process.stdout.write(JSON.stringify({ ok: false, ...(result.error || { error: 'snapshot_not_found' }) }, null, 2) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(result.incident, null, 2) + '\n');
  if (result.strict && result.incident.violated && !result.incident.recovery) process.exit(1);
}

function cmdWatch(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.watcher_strict_default);
  const autoReset = toBool(args['auto-reset'] || args.auto_reset, policy.watcher_auto_reset_default);
  const bootstrapSnapshot = toBool(args['bootstrap-snapshot'] || args.bootstrap_snapshot, true);
  const intervalMs = Math.max(250, Number(args['interval-ms'] || args.interval_ms || policy.watcher_interval_ms || 30000));
  const iterationsTarget = Math.max(0, Number(args.iterations || 0));

  if (bootstrapSnapshot) {
    const current = loadState(policy);
    if (!current.latest_snapshot) {
      createSnapshot(policy, 'watch_bootstrap');
    }
  }

  let iteration = 0;
  let violations = 0;
  let recoveries = 0;
  let lastSnapshotId = null;
  let lastIncidentId = null;

  while (true) {
    const once = runVerifyOnce(policy, {
      snapshot: args.snapshot || 'latest',
      strict,
      autoReset,
      source: 'watch'
    });
    if (!once.incident) {
      process.stdout.write(JSON.stringify({
        ok: false,
        type: 'anti_sabotage_watch',
        ts: nowIso(),
        strict,
        auto_reset: autoReset,
        interval_ms: intervalMs,
        iterations: iteration,
        error: once.error || { error: 'snapshot_not_found' }
      }, null, 2) + '\n');
      process.exit(2);
    }
    iteration += 1;
    lastSnapshotId = once.incident.snapshot_id || null;
    if (once.incident.violated) violations += 1;
    if (once.incident.recovery && once.incident.recovery.incident_id) {
      recoveries += 1;
      lastIncidentId = once.incident.recovery.incident_id;
    }
    saveWatcherState(policy, {
      last_verify_ts: once.incident.ts,
      last_snapshot_id: once.incident.snapshot_id,
      iterations: iteration,
      violations,
      recoveries,
      last_incident_id: lastIncidentId
    });

    if (strict && once.incident.violated && !once.incident.recovery) {
      process.stdout.write(JSON.stringify({
        ok: false,
        type: 'anti_sabotage_watch',
        ts: nowIso(),
        strict,
        auto_reset: autoReset,
        interval_ms: intervalMs,
        iterations: iteration,
        violations,
        recoveries,
        last_snapshot_id: lastSnapshotId,
        last_incident_id: lastIncidentId,
        halt_reason: 'strict_violation_without_recovery'
      }, null, 2) + '\n');
      process.exit(1);
    }

    if (iterationsTarget > 0 && iteration >= iterationsTarget) break;
    sleepMs(intervalMs);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'anti_sabotage_watch',
    ts: nowIso(),
    strict,
    auto_reset: autoReset,
    interval_ms: intervalMs,
    iterations: iteration,
    violations,
    recoveries,
    last_snapshot_id: lastSnapshotId,
    last_incident_id: lastIncidentId
  }, null, 2) + '\n');
}

function cmdStatus() {
  const policy = loadPolicy();
  const state = loadState(policy);
  const watcherState = readJson(watcherStatePath(policy), null);
  const out = {
    ok: true,
    type: 'anti_sabotage_status',
    ts: nowIso(),
    policy_version: policy.version,
    latest_snapshot: state.latest_snapshot,
    latest_snapshot_manifest: state.latest_snapshot_manifest,
    latest_incident: state.latest_incident,
    state_path: relPath(statePath(policy)),
    incident_log: relPath(incidentLogPath(policy)),
    watcher_state_path: relPath(watcherStatePath(policy)),
    watcher_state: watcherState
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'snapshot') return cmdSnapshot(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'watch') return cmdWatch(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  createSnapshot,
  loadSnapshotManifest,
  evaluateSnapshot,
  restoreFromSnapshot
};
export {};

#!/usr/bin/env node
'use strict';
export {};

/**
 * offdevice_memory_replication.js
 *
 * V3-037:
 * - Provider-agnostic, proof-verified off-device memory replication.
 * - Scoped restore drills with receipts.
 * - Fail-safe local-only fallback when remote verification fails.
 *
 * Usage:
 *   node systems/memory/offdevice_memory_replication.js sync [--provider=<id>] [--apply=1|0]
 *   node systems/memory/offdevice_memory_replication.js verify --provider=<id> --snapshot=<id>
 *   node systems/memory/offdevice_memory_replication.js restore-drill --provider=<id> --snapshot=<id> [--scope=all|distilled|state]
 *   node systems/memory/offdevice_memory_replication.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OFFDEVICE_MEMORY_REPLICATION_POLICY_PATH
  ? path.resolve(process.env.OFFDEVICE_MEMORY_REPLICATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'offdevice_memory_replication_policy.json');

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

function cleanText(v: unknown, maxLen = 260) {
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

function shaBuffer(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shaString(str: string) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    fallback_local_only: true,
    max_snapshots: 300,
    source_paths: [
      'state/memory/federation/state.json',
      'state/memory/federation/distilled_latest.json'
    ],
    state: {
      root: 'state/memory/offdevice',
      state_path: 'state/memory/offdevice/state.json',
      latest_path: 'state/memory/offdevice/latest.json',
      receipts_path: 'state/memory/offdevice/receipts.jsonl',
      drills_dir: 'state/memory/offdevice/drills'
    },
    providers: {
      local_mirror: {
        enabled: true,
        type: 'local_mirror',
        root: 'state/memory/offdevice/providers/local_mirror',
        verify_required: true
      }
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  const providersRaw = src.providers && typeof src.providers === 'object' ? src.providers : {};
  const providers: AnyObj = {};
  for (const [providerIdRaw, providerRaw] of Object.entries(providersRaw)) {
    const providerId = normalizeToken(providerIdRaw, 120);
    if (!providerId) continue;
    const row = providerRaw && typeof providerRaw === 'object' ? providerRaw : {};
    providers[providerId] = {
      enabled: row.enabled !== false,
      type: normalizeToken(row.type || 'local_mirror', 80) || 'local_mirror',
      root: resolvePath(row.root || `state/memory/offdevice/providers/${providerId}`, `state/memory/offdevice/providers/${providerId}`),
      verify_required: row.verify_required !== false
    };
  }
  if (!Object.keys(providers).length) {
    providers.local_mirror = {
      enabled: true,
      type: 'local_mirror',
      root: resolvePath(base.providers.local_mirror.root, base.providers.local_mirror.root),
      verify_required: true
    };
  }
  const sourcePaths = Array.isArray(src.source_paths)
    ? src.source_paths.map((row: unknown) => cleanText(row, 400)).filter(Boolean)
    : base.source_paths;
  return {
    version: cleanText(src.version || base.version, 24) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    fallback_local_only: src.fallback_local_only !== false,
    max_snapshots: clampInt(src.max_snapshots, 10, 50000, base.max_snapshots),
    source_paths: sourcePaths.length ? sourcePaths : base.source_paths,
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      drills_dir: resolvePath(state.drills_dir || base.state.drills_dir, base.state.drills_dir)
    },
    providers
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'offdevice_memory_replication_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      providers: {}
    };
  }
  return {
    schema_id: 'offdevice_memory_replication_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    providers: src.providers && typeof src.providers === 'object' ? src.providers : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'offdevice_memory_replication_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    providers: state && state.providers && typeof state.providers === 'object' ? state.providers : {}
  });
}

function buildProviderAdapter(policy: AnyObj, providerIdRaw: unknown) {
  const providerId = normalizeToken(providerIdRaw || '', 120) || 'local_mirror';
  const provider = policy.providers && policy.providers[providerId];
  if (!provider || provider.enabled !== true) return null;
  const root = resolvePath(provider.root, `state/memory/offdevice/providers/${providerId}`);
  const snapshotsDir = path.join(root, 'snapshots');
  return {
    id: providerId,
    config: provider,
    root,
    snapshots_dir: snapshotsDir,
    snapshotDir(snapshotId: string) {
      return path.join(snapshotsDir, snapshotId);
    },
    payloadDir(snapshotId: string) {
      return path.join(snapshotsDir, snapshotId, 'payload');
    },
    manifestPath(snapshotId: string) {
      return path.join(snapshotsDir, snapshotId, 'manifest.json');
    }
  };
}

function gatherSources(policy: AnyObj) {
  const out: AnyObj[] = [];
  for (const srcRaw of policy.source_paths || []) {
    const txt = cleanText(srcRaw, 512);
    if (!txt) continue;
    const abs = path.isAbsolute(txt) ? txt : path.join(ROOT, txt.replace(/\\/g, '/').replace(/^\/+/, '').trim());
    if (!fs.existsSync(abs)) continue;
    let rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) {
      const base = cleanText(path.basename(abs), 120).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'artifact.json';
      rel = `external/${shaString(abs).slice(0, 12)}_${base}`;
    }
    const buf = fs.readFileSync(abs);
    out.push({
      path: rel,
      bytes: buf.length,
      hash: shaBuffer(buf),
      payload: buf.toString('base64')
    });
  }
  out.sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
  return out;
}

function computeAggregateHash(files: AnyObj[]) {
  const seed = (files || [])
    .map((row) => `${String(row.path || '')}:${String(row.hash || '')}:${String(row.bytes || 0)}`)
    .join('|');
  return shaString(seed);
}

function writeSnapshot(adapter: AnyObj, snapshot: AnyObj, files: AnyObj[]) {
  ensureDir(adapter.snapshots_dir);
  const snapDir = adapter.snapshotDir(snapshot.snapshot_id);
  const payloadDir = adapter.payloadDir(snapshot.snapshot_id);
  ensureDir(payloadDir);
  for (const row of files) {
    const dst = path.join(payloadDir, row.path);
    ensureDir(path.dirname(dst));
    fs.writeFileSync(dst, Buffer.from(String(row.payload || ''), 'base64'));
  }
  writeJsonAtomic(adapter.manifestPath(snapshot.snapshot_id), snapshot);
}

function verifySnapshot(adapter: AnyObj, snapshotIdRaw: unknown) {
  const snapshotId = normalizeToken(snapshotIdRaw || '', 180);
  if (!snapshotId) return { ok: false, error: 'snapshot_id_required' };
  const manifestPath = adapter.manifestPath(snapshotId);
  const manifest = readJson(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'manifest_not_found', snapshot_id: snapshotId };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const mismatches: AnyObj[] = [];
  for (const row of files) {
    const rel = String(row && row.path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!rel || rel.includes('..')) {
      mismatches.push({ path: rel || null, reason: 'invalid_rel_path' });
      continue;
    }
    const abs = path.join(adapter.payloadDir(snapshotId), rel);
    if (!fs.existsSync(abs)) {
      mismatches.push({ path: rel, reason: 'missing_payload_file' });
      continue;
    }
    const buf = fs.readFileSync(abs);
    const hash = shaBuffer(buf);
    if (hash !== String(row.hash || '')) {
      mismatches.push({ path: rel, reason: 'hash_mismatch' });
    }
  }
  const expectedAggregate = String(manifest.aggregate_hash || '');
  const actualAggregate = computeAggregateHash(files);
  if (expectedAggregate !== actualAggregate) {
    mismatches.push({ path: null, reason: 'aggregate_hash_mismatch' });
  }
  return {
    ok: mismatches.length === 0,
    snapshot_id: snapshotId,
    files: files.length,
    mismatches,
    aggregate_hash: expectedAggregate
  };
}

function recordLatest(policy: AnyObj, out: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
}

function cmdSync(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/offdevice_memory_replication_policy.json');
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return { ok: false, type: 'offdevice_memory_replication_sync', error: 'policy_disabled' };
  }
  const providerId = normalizeToken(args.provider || args['provider-id'] || 'local_mirror', 120) || 'local_mirror';
  const adapter = buildProviderAdapter(policy, providerId);
  if (!adapter) {
    return { ok: false, type: 'offdevice_memory_replication_sync', error: 'provider_disabled_or_missing', provider_id: providerId };
  }
  const files = gatherSources(policy);
  if (!files.length) {
    return {
      ok: false,
      type: 'offdevice_memory_replication_sync',
      error: 'no_source_files',
      provider_id: providerId
    };
  }
  const snapshotId = `snap_${crypto.createHash('sha256')
    .update(`${providerId}|${nowIso()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const snapshot = {
    schema_id: 'offdevice_memory_replication_manifest',
    schema_version: '1.0',
    ts: nowIso(),
    provider_id: providerId,
    snapshot_id: snapshotId,
    files: files.map((row) => ({
      path: row.path,
      bytes: Number(row.bytes || 0),
      hash: row.hash
    })),
    aggregate_hash: computeAggregateHash(files)
  };
  const apply = toBool(args.apply, true) && policy.shadow_only !== true;
  let verified: AnyObj = { ok: true, snapshot_id: snapshotId, files: files.length, mismatches: [] };
  if (apply) {
    writeSnapshot(adapter, snapshot, files);
    verified = verifySnapshot(adapter, snapshotId);
  }
  const fallbackLocalOnly = policy.fallback_local_only === true && verified.ok !== true;
  const out = {
    ok: verified.ok === true || fallbackLocalOnly === true,
    type: 'offdevice_memory_replication_sync',
    ts: nowIso(),
    provider_id: providerId,
    snapshot_id: snapshotId,
    files: files.length,
    aggregate_hash: snapshot.aggregate_hash,
    applied: apply,
    verify_ok: verified.ok === true,
    fallback_local_only: fallbackLocalOnly,
    reason: verified.ok === true ? null : (verified.mismatches && verified.mismatches[0] && verified.mismatches[0].reason) || 'verify_failed',
    policy_path: relPath(policyPath)
  };
  if (apply && (verified.ok === true || fallbackLocalOnly === true)) {
    const state = loadState(policy);
    const providerState = state.providers[providerId] && typeof state.providers[providerId] === 'object'
      ? state.providers[providerId]
      : { snapshots: [] };
    const snapshots = Array.isArray(providerState.snapshots) ? providerState.snapshots : [];
    snapshots.push({
      snapshot_id: snapshotId,
      ts: snapshot.ts,
      files: files.length,
      aggregate_hash: snapshot.aggregate_hash,
      verify_ok: verified.ok === true
    });
    providerState.snapshots = snapshots.slice(-Number(policy.max_snapshots || 300));
    providerState.latest_snapshot_id = snapshotId;
    providerState.latest_verify_ok = verified.ok === true;
    state.providers[providerId] = providerState;
    saveState(policy, state);
  }
  recordLatest(policy, out);
  return out;
}

function cmdVerify(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/offdevice_memory_replication_policy.json');
  const policy = loadPolicy(policyPath);
  const providerId = normalizeToken(args.provider || args['provider-id'] || '', 120);
  if (!providerId) return { ok: false, type: 'offdevice_memory_replication_verify', error: 'provider_required' };
  const adapter = buildProviderAdapter(policy, providerId);
  if (!adapter) return { ok: false, type: 'offdevice_memory_replication_verify', error: 'provider_disabled_or_missing', provider_id: providerId };
  const snapshotId = normalizeToken(args.snapshot || args['snapshot-id'] || '', 180);
  if (!snapshotId) return { ok: false, type: 'offdevice_memory_replication_verify', error: 'snapshot_required' };
  const verified = verifySnapshot(adapter, snapshotId);
  const out = {
    ok: verified.ok === true,
    type: 'offdevice_memory_replication_verify',
    ts: nowIso(),
    provider_id: providerId,
    snapshot_id: snapshotId,
    files: Number(verified.files || 0),
    mismatches: Array.isArray(verified.mismatches) ? verified.mismatches.slice(0, 50) : [],
    aggregate_hash: verified.aggregate_hash || null
  };
  recordLatest(policy, out);
  return out;
}

function cmdRestoreDrill(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/offdevice_memory_replication_policy.json');
  const policy = loadPolicy(policyPath);
  const providerId = normalizeToken(args.provider || args['provider-id'] || '', 120);
  if (!providerId) return { ok: false, type: 'offdevice_memory_replication_restore_drill', error: 'provider_required' };
  const adapter = buildProviderAdapter(policy, providerId);
  if (!adapter) return { ok: false, type: 'offdevice_memory_replication_restore_drill', error: 'provider_disabled_or_missing', provider_id: providerId };
  const snapshotId = normalizeToken(args.snapshot || args['snapshot-id'] || '', 180);
  if (!snapshotId) return { ok: false, type: 'offdevice_memory_replication_restore_drill', error: 'snapshot_required' };
  const verify = verifySnapshot(adapter, snapshotId);
  if (!verify.ok) {
    const out = {
      ok: true,
      type: 'offdevice_memory_replication_restore_drill',
      ts: nowIso(),
      provider_id: providerId,
      snapshot_id: snapshotId,
      fallback_local_only: true,
      restored_files: 0,
      reason: verify.mismatches && verify.mismatches[0] && verify.mismatches[0].reason || 'verify_failed'
    };
    recordLatest(policy, out);
    return out;
  }
  const manifest = readJson(adapter.manifestPath(snapshotId), {});
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const scope = normalizeToken(args.scope || 'all', 40) || 'all';
  const selected = files.filter((row: AnyObj) => {
    const p = String(row && row.path || '');
    if (scope === 'state') return /\/state\.json$/i.test(p);
    if (scope === 'distilled') return /distilled_latest\.json$/i.test(p);
    return true;
  });
  const drillId = `drill_${crypto.createHash('sha256')
    .update(`${providerId}|${snapshotId}|${nowIso()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const drillRoot = path.join(policy.state.drills_dir, drillId, 'restored');
  ensureDir(drillRoot);
  let restored = 0;
  const mismatches: AnyObj[] = [];
  for (const row of selected) {
    const rel = String(row && row.path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!rel || rel.includes('..')) continue;
    const src = path.join(adapter.payloadDir(snapshotId), rel);
    const dst = path.join(drillRoot, rel);
    if (!fs.existsSync(src)) {
      mismatches.push({ path: rel, reason: 'missing_payload_file' });
      continue;
    }
    ensureDir(path.dirname(dst));
    const buf = fs.readFileSync(src);
    fs.writeFileSync(dst, buf);
    const hash = shaBuffer(buf);
    if (hash !== String(row.hash || '')) {
      mismatches.push({ path: rel, reason: 'drill_hash_mismatch' });
      continue;
    }
    restored += 1;
  }
  const out = {
    ok: mismatches.length === 0,
    type: 'offdevice_memory_replication_restore_drill',
    ts: nowIso(),
    provider_id: providerId,
    snapshot_id: snapshotId,
    scope,
    drill_id: drillId,
    drill_path: relPath(drillRoot),
    restored_files: restored,
    expected_files: selected.length,
    mismatches: mismatches.slice(0, 50),
    fallback_local_only: false
  };
  recordLatest(policy, out);
  return out;
}

function cmdStatus(args: AnyObj = {}) {
  const policyPath = resolvePath(args.policy || DEFAULT_POLICY_PATH, 'config/offdevice_memory_replication_policy.json');
  const policy = loadPolicy(policyPath);
  const state = loadState(policy);
  const providers: AnyObj = {};
  for (const [providerId, row] of Object.entries(policy.providers || {})) {
    const pState = state.providers && state.providers[providerId] && typeof state.providers[providerId] === 'object'
      ? state.providers[providerId]
      : {};
    providers[providerId] = {
      enabled: row && row.enabled === true,
      type: row && row.type || null,
      latest_snapshot_id: pState.latest_snapshot_id || null,
      latest_verify_ok: pState.latest_verify_ok === true,
      snapshots: Array.isArray(pState.snapshots) ? pState.snapshots.length : 0
    };
  }
  return {
    ok: true,
    type: 'offdevice_memory_replication_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      fallback_local_only: policy.fallback_local_only === true
    },
    providers,
    paths: {
      state_path: relPath(policy.state.state_path),
      latest_path: relPath(policy.state.latest_path),
      receipts_path: relPath(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/offdevice_memory_replication.js sync [--provider=<id>] [--apply=1|0]');
  console.log('  node systems/memory/offdevice_memory_replication.js verify --provider=<id> --snapshot=<id>');
  console.log('  node systems/memory/offdevice_memory_replication.js restore-drill --provider=<id> --snapshot=<id> [--scope=all|distilled|state]');
  console.log('  node systems/memory/offdevice_memory_replication.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'sync') out = cmdSync(args);
  else if (cmd === 'verify') out = cmdVerify(args);
  else if (cmd === 'restore-drill') out = cmdRestoreDrill(args);
  else if (cmd === 'status') out = cmdStatus(args);
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
  cmdSync,
  cmdVerify,
  cmdRestoreDrill,
  cmdStatus
};

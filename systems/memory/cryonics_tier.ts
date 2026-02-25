#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY = 'config/cryonics_policy.json';
const DAY_MS = 24 * 60 * 60 * 1000;

type AnyObj = Record<string, any>;

type TierPolicy = {
  id: string,
  source_prefixes: string[],
  dest_prefix: string,
  compression: 'gzip',
  min_age_days: number
};

type ProfilePolicy = {
  id: string,
  description: string,
  registry_path: string,
  remove_source_after_verify: boolean,
  keep_versions_per_source: number,
  max_files_per_run: number,
  tiers: TierPolicy[]
};

type RegistryVersion = {
  archived_rel: string,
  tier_id: string,
  compression: 'gzip',
  archived_at: string,
  source_sha256: string,
  source_size_bytes: number,
  archived_size_bytes: number,
  source_mtime_ms: number,
  verify_sha256: string,
  source_deleted: boolean
};

type RegistryEntry = {
  source_rel: string,
  state: 'archived' | 'mirrored' | 'restored',
  latest: RegistryVersion | null,
  versions: RegistryVersion[]
};

type CryonicsRegistry = {
  type: 'cryonics_registry',
  version: '1.0',
  profile: string,
  updated_at: string,
  entries: Record<string, RegistryEntry>
};

function usage() {
  console.log('cryonics_tier.js - tiered gzip archival for state files');
  console.log('');
  console.log('Usage:');
  console.log('  node systems/memory/cryonics_tier.js run [--root=<abs>] [--policy=<rel|abs>] [--profile=<id>] [--dry-run] [--max-files=N] [--date=YYYY-MM-DD]');
  console.log('  node systems/memory/cryonics_tier.js status [--root=<abs>] [--policy=<rel|abs>] [--profile=<id>]');
  console.log('  node systems/memory/cryonics_tier.js verify [--root=<abs>] [--policy=<rel|abs>] [--profile=<id>] [--limit=N]');
  console.log('  node systems/memory/cryonics_tier.js restore --source=<rel> [--root=<abs>] [--policy=<rel|abs>] [--profile=<id>] [--force] [--dry-run]');
  console.log('  node systems/memory/cryonics_tier.js restore --all [--root=<abs>] [--policy=<rel|abs>] [--profile=<id>] [--force] [--dry-run] [--limit=N]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeRelPath(v: any) {
  const raw = String(v || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return '';
  if (raw === '.' || raw.includes('..')) {
    throw new Error(`invalid_relative_path:${String(v || '')}`);
  }
  return raw;
}

function normalizeCompression(v: any): 'gzip' {
  const raw = String(v || 'gzip').trim().toLowerCase();
  if (raw !== 'gzip') throw new Error(`unsupported_compression:${raw}`);
  return 'gzip';
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function relPath(root: string, absPath: string) {
  return path.relative(root, absPath).replace(/\\/g, '/');
}

function isInsideRoot(root: string, absPath: string) {
  const rel = relPath(root, absPath);
  return !!rel && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function walkFiles(absDir: string, root: string, out: string[]) {
  if (!fs.existsSync(absDir)) return;
  let st;
  try {
    st = fs.statSync(absDir);
  } catch {
    return;
  }
  if (st.isFile()) {
    const rel = relPath(root, absDir);
    if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;

  const stack = [absDir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = relPath(root, full);
      if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) continue;
      out.push(rel);
    }
  }
}

function sha256Buffer(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gzipBuffer(buf: Buffer) {
  return zlib.gzipSync(buf, { level: 9 });
}

function gunzipBuffer(buf: Buffer) {
  return zlib.gunzipSync(buf);
}

function loadPolicy(root: string, args: AnyObj): ProfilePolicy {
  const policyArg = String(args.policy || process.env.CRYONICS_POLICY_PATH || DEFAULT_POLICY).trim();
  const policyPath = path.isAbsolute(policyArg) ? policyArg : path.join(root, policyArg);
  const raw = readJsonSafe(policyPath, {}) as AnyObj;
  const profileId = String(args.profile || process.env.CRYONICS_PROFILE || raw.default_profile || 'state_phase1').trim();
  const profiles = raw && typeof raw.profiles === 'object' ? raw.profiles : {};
  const src = profiles[profileId];
  if (!src || typeof src !== 'object') {
    throw new Error(`cryonics_profile_not_found:${profileId}`);
  }

  const tiersRaw = Array.isArray(src.tiers) ? src.tiers : [];
  if (!tiersRaw.length) throw new Error(`cryonics_profile_no_tiers:${profileId}`);

  const tiers: TierPolicy[] = tiersRaw.map((row: AnyObj, idx: number) => {
    const id = normalizeRelPath(row.id || `tier_${idx + 1}`);
    const sourcePrefixes = Array.isArray(row.source_prefixes)
      ? row.source_prefixes.map(normalizeRelPath).filter(Boolean)
      : [];
    if (!sourcePrefixes.length) {
      throw new Error(`cryonics_tier_no_sources:${id}`);
    }
    const destPrefix = normalizeRelPath(row.dest_prefix || 'state/_cryonics/warm');
    const compression = normalizeCompression(row.compression || 'gzip');
    const minAgeDays = clampInt(row.min_age_days, 0, 3650, 7);
    return {
      id,
      source_prefixes: sourcePrefixes,
      dest_prefix: destPrefix,
      compression,
      min_age_days: minAgeDays
    };
  });

  const registryPath = normalizeRelPath(src.registry_path || 'state/memory/cryonics_registry.json');
  const removeSource = src.remove_source_after_verify !== false;
  const keepVersions = clampInt(src.keep_versions_per_source, 1, 100, 6);
  const maxFiles = clampInt(src.max_files_per_run, 1, 100000, 5000);

  return {
    id: profileId,
    description: String(src.description || '').trim(),
    registry_path: registryPath,
    remove_source_after_verify: removeSource,
    keep_versions_per_source: keepVersions,
    max_files_per_run: maxFiles,
    tiers
  };
}

function registryPathAbs(root: string, policy: ProfilePolicy) {
  return path.join(root, policy.registry_path);
}

function baseRegistry(profileId: string): CryonicsRegistry {
  return {
    type: 'cryonics_registry',
    version: '1.0',
    profile: profileId,
    updated_at: nowIso(),
    entries: {}
  };
}

function normalizeRegistry(raw: AnyObj, profileId: string): CryonicsRegistry {
  const out = baseRegistry(profileId);
  if (!raw || typeof raw !== 'object') return out;
  if (raw.type === 'cryonics_registry') out.type = 'cryonics_registry';
  if (String(raw.version || '') === '1.0') out.version = '1.0';
  out.profile = String(raw.profile || profileId).trim() || profileId;
  out.updated_at = String(raw.updated_at || nowIso());
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const key of Object.keys(entries)) {
    const sourceRel = normalizeRelPath(key);
    const row = entries[key];
    if (!sourceRel || !row || typeof row !== 'object') continue;
    const versionsRaw = Array.isArray(row.versions) ? row.versions : [];
    const versions: RegistryVersion[] = [];
    for (const v of versionsRaw) {
      if (!v || typeof v !== 'object') continue;
      const archivedRel = normalizeRelPath(v.archived_rel || '');
      if (!archivedRel) continue;
      versions.push({
        archived_rel: archivedRel,
        tier_id: normalizeRelPath(v.tier_id || 'warm'),
        compression: normalizeCompression(v.compression || 'gzip'),
        archived_at: String(v.archived_at || nowIso()),
        source_sha256: String(v.source_sha256 || ''),
        source_size_bytes: Number(v.source_size_bytes || 0),
        archived_size_bytes: Number(v.archived_size_bytes || 0),
        source_mtime_ms: Number(v.source_mtime_ms || 0),
        verify_sha256: String(v.verify_sha256 || ''),
        source_deleted: v.source_deleted === true
      });
    }
    const latest = versions.length ? versions[versions.length - 1] : null;
    out.entries[sourceRel] = {
      source_rel: sourceRel,
      state: (row.state === 'restored' ? 'restored' : row.state === 'mirrored' ? 'mirrored' : 'archived'),
      latest,
      versions
    };
  }
  return out;
}

function loadRegistry(root: string, policy: ProfilePolicy) {
  const p = registryPathAbs(root, policy);
  const raw = readJsonSafe(p, {});
  return normalizeRegistry(raw, policy.id);
}

function saveRegistry(root: string, policy: ProfilePolicy, registry: CryonicsRegistry) {
  const p = registryPathAbs(root, policy);
  ensureDir(path.dirname(p));
  registry.updated_at = nowIso();
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

function tierForSource(policy: ProfilePolicy, sourceRel: string): TierPolicy | null {
  for (const tier of policy.tiers) {
    for (const pref of tier.source_prefixes) {
      if (sourceRel === pref || sourceRel.startsWith(`${pref}/`)) return tier;
    }
  }
  return null;
}

function archiveRelFor(tier: TierPolicy, sourceRel: string) {
  return `${normalizeRelPath(tier.dest_prefix)}/${sourceRel}.gz`;
}

function shouldSkipSource(policy: ProfilePolicy, sourceRel: string) {
  if (!sourceRel || sourceRel.endsWith('.gz')) return true;
  for (const tier of policy.tiers) {
    const pref = String(tier.dest_prefix || '');
    if (pref && (sourceRel === pref || sourceRel.startsWith(`${pref}/`))) return true;
  }
  if (sourceRel === policy.registry_path) return true;
  return false;
}

function collectCandidates(root: string, policy: ProfilePolicy, maxFilesOverride: number | null, nowMs: number) {
  const scanned = new Set<string>();
  const out: Array<{ source_rel: string, tier: TierPolicy, mtime_ms: number, age_days: number }> = [];
  const maxFiles = Math.max(1, Math.min(200000, maxFilesOverride || policy.max_files_per_run));

  for (const tier of policy.tiers) {
    for (const srcPrefix of tier.source_prefixes) {
      const abs = path.join(root, srcPrefix);
      const files: string[] = [];
      walkFiles(abs, root, files);
      for (const sourceRel of files) {
        if (scanned.has(sourceRel)) continue;
        scanned.add(sourceRel);
        if (shouldSkipSource(policy, sourceRel)) continue;
        if (!isInsideRoot(root, path.join(root, sourceRel))) continue;

        let st;
        try {
          st = fs.statSync(path.join(root, sourceRel));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const ageMs = Math.max(0, nowMs - Number(st.mtimeMs || 0));
        const ageDays = ageMs / DAY_MS;
        if (ageDays < Number(tier.min_age_days || 0)) continue;

        out.push({
          source_rel: sourceRel,
          tier,
          mtime_ms: Number(st.mtimeMs || 0),
          age_days: Number(ageDays.toFixed(3))
        });
        if (out.length >= maxFiles) return out;
      }
    }
  }

  out.sort((a, b) => {
    if (b.age_days !== a.age_days) return b.age_days - a.age_days;
    return a.source_rel.localeCompare(b.source_rel);
  });
  return out;
}

function upsertRegistryEntry(registry: CryonicsRegistry, policy: ProfilePolicy, sourceRel: string, version: RegistryVersion, state: 'archived' | 'mirrored' | 'restored') {
  const current = registry.entries[sourceRel] || {
    source_rel: sourceRel,
    state,
    latest: null,
    versions: []
  };
  const versions = Array.isArray(current.versions) ? current.versions.slice() : [];
  const last = versions.length ? versions[versions.length - 1] : null;
  const sameAsLast = !!last
    && String(last.source_sha256 || '') === String(version.source_sha256 || '')
    && String(last.archived_rel || '') === String(version.archived_rel || '')
    && String(last.tier_id || '') === String(version.tier_id || '');

  if (!sameAsLast) {
    versions.push(version);
  }

  while (versions.length > policy.keep_versions_per_source) versions.shift();

  registry.entries[sourceRel] = {
    source_rel: sourceRel,
    state,
    latest: versions.length ? versions[versions.length - 1] : version,
    versions
  };
}

function cmdRun(args: AnyObj) {
  const root = path.resolve(String(args.root || process.env.CRYONICS_ROOT || DEFAULT_ROOT));
  const policy = loadPolicy(root, args);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const maxFiles = args['max-files'] != null ? clampInt(args['max-files'], 1, 200000, policy.max_files_per_run) : null;
  const nowMs = Date.now();

  const registry = loadRegistry(root, policy);
  const candidates = collectCandidates(root, policy, maxFiles, nowMs);

  const summary = {
    ok: true,
    type: 'cryonics_tier_run',
    ts: nowIso(),
    root,
    profile: policy.id,
    dry_run: dryRun,
    scanned_candidates: candidates.length,
    archived_count: 0,
    dedup_count: 0,
    skipped_count: 0,
    source_deleted_count: 0,
    bytes_before: 0,
    bytes_after: 0,
    errors: [] as Array<{ source_rel: string, error: string }>,
    archived: [] as Array<AnyObj>
  };

  for (const cand of candidates) {
    const sourceRel = cand.source_rel;
    const sourceAbs = path.join(root, sourceRel);

    try {
      const tier = tierForSource(policy, sourceRel) || cand.tier;
      if (!tier) {
        summary.skipped_count += 1;
        continue;
      }

      const srcBuf = fs.readFileSync(sourceAbs);
      const srcSha = sha256Buffer(srcBuf);
      const srcSize = Number(srcBuf.length || 0);
      const archiveRel = archiveRelFor(tier, sourceRel);
      const archiveAbs = path.join(root, archiveRel);

      const current = registry.entries[sourceRel];
      const latest = current && current.latest ? current.latest : null;
      const dedupAvailable = !!latest
        && String(latest.source_sha256 || '') === srcSha
        && String(latest.archived_rel || '') === archiveRel
        && fs.existsSync(path.join(root, latest.archived_rel));

      summary.bytes_before += srcSize;

      if (dedupAvailable) {
        summary.dedup_count += 1;
        summary.bytes_after += Number(latest && latest.archived_size_bytes || 0);

        if (policy.remove_source_after_verify && !dryRun) {
          fs.unlinkSync(sourceAbs);
          summary.source_deleted_count += 1;
          current.state = 'archived';
        }

        summary.archived.push({
          source_rel: sourceRel,
          archived_rel: archiveRel,
          tier_id: tier.id,
          source_size_bytes: srcSize,
          archived_size_bytes: Number(latest && latest.archived_size_bytes || 0),
          age_days: cand.age_days,
          action: policy.remove_source_after_verify ? 'dedup_delete_source' : 'dedup_keep_source'
        });
        continue;
      }

      const zipped = gzipBuffer(srcBuf);
      const verifyBuf = gunzipBuffer(zipped);
      const verifySha = sha256Buffer(verifyBuf);
      if (verifySha !== srcSha) {
        throw new Error('verify_sha_mismatch');
      }

      const version: RegistryVersion = {
        archived_rel: archiveRel,
        tier_id: tier.id,
        compression: 'gzip',
        archived_at: nowIso(),
        source_sha256: srcSha,
        source_size_bytes: srcSize,
        archived_size_bytes: Number(zipped.length || 0),
        source_mtime_ms: Number(cand.mtime_ms || 0),
        verify_sha256: verifySha,
        source_deleted: policy.remove_source_after_verify
      };

      if (!dryRun) {
        ensureDir(path.dirname(archiveAbs));
        fs.writeFileSync(archiveAbs, zipped);
        if (policy.remove_source_after_verify) {
          fs.unlinkSync(sourceAbs);
          summary.source_deleted_count += 1;
        }
        upsertRegistryEntry(registry, policy, sourceRel, version, policy.remove_source_after_verify ? 'archived' : 'mirrored');
      }

      summary.archived_count += 1;
      summary.bytes_after += Number(zipped.length || 0);
      summary.archived.push({
        source_rel: sourceRel,
        archived_rel: archiveRel,
        tier_id: tier.id,
        source_size_bytes: srcSize,
        archived_size_bytes: Number(zipped.length || 0),
        age_days: cand.age_days,
        action: policy.remove_source_after_verify ? 'compressed_and_deleted_source' : 'compressed_keep_source'
      });
    } catch (err: any) {
      summary.errors.push({
        source_rel: sourceRel,
        error: String(err && err.message || 'unknown_error')
      });
    }
  }

  if (!dryRun) {
    saveRegistry(root, policy, registry);
  }

  summary.ok = summary.errors.length === 0;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (!summary.ok) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const root = path.resolve(String(args.root || process.env.CRYONICS_ROOT || DEFAULT_ROOT));
  const policy = loadPolicy(root, args);
  const registry = loadRegistry(root, policy);

  let entries = 0;
  let archivedBytes = 0;
  let sourceBytes = 0;
  const perTier: Record<string, { entries: number, archived_bytes: number, source_bytes: number }> = {};

  for (const key of Object.keys(registry.entries || {})) {
    const row = registry.entries[key];
    if (!row || !row.latest) continue;
    entries += 1;
    const latest = row.latest;
    archivedBytes += Number(latest.archived_size_bytes || 0);
    sourceBytes += Number(latest.source_size_bytes || 0);
    const tierId = String(latest.tier_id || 'unknown');
    if (!perTier[tierId]) {
      perTier[tierId] = { entries: 0, archived_bytes: 0, source_bytes: 0 };
    }
    perTier[tierId].entries += 1;
    perTier[tierId].archived_bytes += Number(latest.archived_size_bytes || 0);
    perTier[tierId].source_bytes += Number(latest.source_size_bytes || 0);
  }

  const savingsPct = sourceBytes > 0
    ? Number(((1 - (archivedBytes / sourceBytes)) * 100).toFixed(2))
    : 0;

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'cryonics_tier_status',
    ts: nowIso(),
    root,
    profile: policy.id,
    registry_path: policy.registry_path,
    entries,
    source_bytes: sourceBytes,
    archived_bytes: archivedBytes,
    savings_pct: savingsPct,
    per_tier: perTier,
    updated_at: registry.updated_at || null
  }, null, 2) + '\n');
}

function cmdVerify(args: AnyObj) {
  const root = path.resolve(String(args.root || process.env.CRYONICS_ROOT || DEFAULT_ROOT));
  const policy = loadPolicy(root, args);
  const registry = loadRegistry(root, policy);
  const limit = clampInt(args.limit, 1, 500000, 500000);

  let checked = 0;
  let okCount = 0;
  const failures: Array<{ source_rel: string, archived_rel: string, error: string }> = [];

  for (const sourceRel of Object.keys(registry.entries || {})) {
    if (checked >= limit) break;
    const row = registry.entries[sourceRel];
    if (!row || !row.latest) continue;
    const latest = row.latest;
    checked += 1;

    try {
      const archiveAbs = path.join(root, latest.archived_rel);
      if (!fs.existsSync(archiveAbs)) throw new Error('archive_missing');
      const zipped = fs.readFileSync(archiveAbs);
      const unzipped = gunzipBuffer(zipped);
      const sha = sha256Buffer(unzipped);
      if (sha !== String(latest.source_sha256 || '')) {
        throw new Error('source_sha_mismatch');
      }
      okCount += 1;
    } catch (err: any) {
      failures.push({
        source_rel: sourceRel,
        archived_rel: String(latest.archived_rel || ''),
        error: String(err && err.message || 'verify_failed')
      });
    }
  }

  const out = {
    ok: failures.length === 0,
    type: 'cryonics_tier_verify',
    ts: nowIso(),
    root,
    profile: policy.id,
    checked,
    verified: okCount,
    failed: failures.length,
    failures: failures.slice(0, 100)
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!out.ok) process.exit(1);
}

function cmdRestore(args: AnyObj) {
  const root = path.resolve(String(args.root || process.env.CRYONICS_ROOT || DEFAULT_ROOT));
  const policy = loadPolicy(root, args);
  const registry = loadRegistry(root, policy);
  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const force = args.force === true;
  const all = args.all === true;
  const sourceArg = String(args.source || '').trim();
  const limit = clampInt(args.limit, 1, 500000, 500000);

  if (!all && !sourceArg) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'source_required_or_use_all' }) + '\n');
    process.exit(2);
  }

  const targets: string[] = [];
  if (all) {
    for (const key of Object.keys(registry.entries || {})) {
      if (targets.length >= limit) break;
      targets.push(key);
    }
  } else {
    targets.push(normalizeRelPath(sourceArg));
  }

  let restored = 0;
  let skipped = 0;
  const errors: Array<{ source_rel: string, error: string }> = [];
  const rows: AnyObj[] = [];

  for (const sourceRel of targets) {
    const entry = registry.entries[sourceRel];
    if (!entry || !entry.latest) {
      errors.push({ source_rel: sourceRel, error: 'registry_entry_missing' });
      continue;
    }

    try {
      const latest = entry.latest;
      const archiveAbs = path.join(root, latest.archived_rel);
      if (!fs.existsSync(archiveAbs)) throw new Error('archive_missing');
      const sourceAbs = path.join(root, sourceRel);
      const sourceExists = fs.existsSync(sourceAbs);
      if (sourceExists && !force) {
        skipped += 1;
        rows.push({ source_rel: sourceRel, skipped: true, reason: 'source_exists_use_force' });
        continue;
      }

      const zipped = fs.readFileSync(archiveAbs);
      const unzipped = gunzipBuffer(zipped);
      const sha = sha256Buffer(unzipped);
      if (sha !== String(latest.source_sha256 || '')) throw new Error('source_sha_mismatch');

      if (!dryRun) {
        ensureDir(path.dirname(sourceAbs));
        fs.writeFileSync(sourceAbs, unzipped);
        if (Number(latest.source_mtime_ms || 0) > 0) {
          const ts = Number(latest.source_mtime_ms || 0) / 1000;
          fs.utimesSync(sourceAbs, ts, ts);
        }
        entry.state = 'restored';
      }

      restored += 1;
      rows.push({
        source_rel: sourceRel,
        archived_rel: latest.archived_rel,
        restored_size_bytes: Number(unzipped.length || 0),
        dry_run: dryRun
      });
    } catch (err: any) {
      errors.push({ source_rel: sourceRel, error: String(err && err.message || 'restore_failed') });
    }
  }

  if (!dryRun) {
    saveRegistry(root, policy, registry);
  }

  const out = {
    ok: errors.length === 0,
    type: 'cryonics_tier_restore',
    ts: nowIso(),
    root,
    profile: policy.id,
    dry_run: dryRun,
    force,
    requested: targets.length,
    restored,
    skipped,
    errors,
    rows: rows.slice(0, 100)
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!out.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'restore') return cmdRestore(args);

  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stderr.write(`cryonics_tier.js: FAIL: ${String(err && err.message || err)}\n`);
    process.exit(1);
  }
}

export {
  normalizeRelPath,
  archiveRelFor,
  collectCandidates,
  normalizeRegistry
};

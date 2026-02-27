#!/usr/bin/env node
'use strict';
export {};

/**
 * compression_transfer_plane.js
 *
 * RM-126: deterministic compression/expansion transfer plane.
 *
 * Usage:
 *   node systems/hardware/compression_transfer_plane.js compress [--strict=1|0]
 *   node systems/hardware/compression_transfer_plane.js expand --bundle-id=<id> [--apply=1|0] [--strict=1|0]
 *   node systems/hardware/compression_transfer_plane.js auto [--target-profile=phone|desktop|cluster] [--apply=1|0] [--strict=1|0]
 *   node systems/hardware/compression_transfer_plane.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readLatestEmbodiment, loadPolicy: loadEmbodimentPolicy, makeEmbodimentSnapshot } = require('./embodiment_layer.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.COMPRESSION_TRANSFER_PLANE_POLICY_PATH
  ? path.resolve(String(process.env.COMPRESSION_TRANSFER_PLANE_POLICY_PATH))
  : path.join(ROOT, 'config', 'compression_transfer_plane_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
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
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function hashText(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function profileRank(profileId: unknown) {
  const id = normalizeToken(profileId || '', 40);
  if (id === 'phone' || id === 'phone_seed') return 1;
  if (id === 'desktop' || id === 'desktop_seed') return 2;
  if (id === 'cluster' || id === 'cluster_sim') return 3;
  return 0;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    apply_default: false,
    embodiment_policy_path: 'config/embodiment_layer_policy.json',
    bundle_dir: 'state/hardware/compression_transfer_plane/bundles',
    latest_path: 'state/hardware/compression_transfer_plane/latest.json',
    receipts_path: 'state/hardware/compression_transfer_plane/receipts.jsonl',
    include_paths: [
      'state/runtime/scheduler_mode/latest.json',
      'state/hardware/embodiment/latest.json',
      'state/hardware/surface_budget/latest.json',
      'state/ops/phone_seed_profile/status.json'
    ]
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rootPath = (value: unknown, fallback: string) => {
    const text = clean(value || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  const include = Array.isArray(raw.include_paths) ? raw.include_paths : base.include_paths;
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    apply_default: toBool(raw.apply_default, base.apply_default),
    embodiment_policy_path: rootPath(raw.embodiment_policy_path, base.embodiment_policy_path),
    bundle_dir: rootPath(raw.bundle_dir, base.bundle_dir),
    latest_path: rootPath(raw.latest_path, base.latest_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    include_paths: include
      .map((p: unknown) => clean(p, 320))
      .filter(Boolean)
      .map((p: string) => (path.isAbsolute(p) ? path.resolve(p) : path.join(ROOT, p))),
    policy_path: path.resolve(policyPath)
  };
}

function senseEmbodiment(policy: AnyObj) {
  let snapshot = readLatestEmbodiment(policy.embodiment_policy_path);
  if (!snapshot) {
    const ePolicy = loadEmbodimentPolicy(policy.embodiment_policy_path);
    snapshot = makeEmbodimentSnapshot(ePolicy, 'auto');
  }
  return snapshot;
}

function listBundleIds(policy: AnyObj) {
  if (!fs.existsSync(policy.bundle_dir)) return [];
  return fs.readdirSync(policy.bundle_dir)
    .filter((name: string) => name.endsWith('.json'))
    .map((name: string) => name.slice(0, -5))
    .sort();
}

function readBundle(policy: AnyObj, bundleId: string) {
  const safeId = normalizeToken(bundleId, 160);
  if (!safeId) return null;
  const bundlePath = path.join(policy.bundle_dir, `${safeId}.json`);
  if (!fs.existsSync(bundlePath)) return null;
  const payload = readJson(bundlePath, null);
  if (!payload || typeof payload !== 'object') return null;
  return { id: safeId, path: bundlePath, payload };
}

function bundleDigest(files: AnyObj[]) {
  const canonical = JSON.stringify(files.map((row) => ({
    path: row.path,
    exists: row.exists === true,
    sha256: row.sha256 || null
  })));
  return hashText(canonical);
}

function captureFiles(policy: AnyObj) {
  const rows: AnyObj[] = [];
  for (const abs of policy.include_paths) {
    const exists = fs.existsSync(abs);
    if (!exists) {
      rows.push({
        path: rel(abs),
        exists: false,
        sha256: null,
        bytes: 0,
        body_b64: null
      });
      continue;
    }
    const body = fs.readFileSync(abs, 'utf8');
    rows.push({
      path: rel(abs),
      exists: true,
      sha256: hashText(body),
      bytes: Buffer.byteLength(body, 'utf8'),
      body_b64: Buffer.from(body, 'utf8').toString('base64')
    });
  }
  return rows;
}

function cmdCompress(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'compression_transfer_compress', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const embodiment = senseEmbodiment(policy);
  const files = captureFiles(policy);
  const digest = bundleDigest(files);
  const bundleId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${digest.slice(0, 12)}`;
  const bundle = {
    schema_id: 'compression_transfer_bundle',
    schema_version: '1.0',
    created_at: nowIso(),
    bundle_id: bundleId,
    profile_id: clean(embodiment?.profile_id || '', 40) || null,
    surface_budget_score: Number.isFinite(Number(embodiment?.surface_budget?.score))
      ? Number(embodiment.surface_budget.score)
      : null,
    digest,
    files
  };
  ensureDir(policy.bundle_dir);
  writeJsonAtomic(path.join(policy.bundle_dir, `${bundleId}.json`), bundle);

  const out = {
    ok: true,
    type: 'compression_transfer_compress',
    ts: nowIso(),
    bundle_id: bundleId,
    digest,
    file_count: files.length,
    profile_id: bundle.profile_id,
    policy_path: rel(policy.policy_path),
    bundle_path: rel(path.join(policy.bundle_dir, `${bundleId}.json`))
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdExpand(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const apply = toBool(args.apply, policy.apply_default === true);
  const bundleId = normalizeToken(args['bundle-id'] || args.bundle_id || args.id || '', 160);
  if (!bundleId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'compression_transfer_expand', error: 'bundle_id_required' })}\n`);
    process.exit(1);
  }
  const bundleRef = readBundle(policy, bundleId);
  if (!bundleRef) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'compression_transfer_expand', error: 'bundle_not_found', bundle_id: bundleId })}\n`);
    process.exit(1);
  }
  const payload = bundleRef.payload;
  const files = Array.isArray(payload.files) ? payload.files : [];
  const digest = bundleDigest(files);
  const digestOk = clean(payload.digest || '', 200) === digest;
  const writes: AnyObj[] = [];
  if (apply && digestOk) {
    for (const row of files) {
      const relPath = clean(row.path || '', 320);
      if (!relPath) continue;
      const abs = path.join(ROOT, relPath);
      if (row.exists === true) {
        const body = Buffer.from(String(row.body_b64 || ''), 'base64').toString('utf8');
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, body, 'utf8');
        writes.push({ path: relPath, restored: true, bytes: Buffer.byteLength(body, 'utf8') });
      } else if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        writes.push({ path: relPath, removed: true });
      }
    }
  }
  const out = {
    ok: digestOk,
    type: 'compression_transfer_expand',
    ts: nowIso(),
    apply,
    bundle_id: bundleRef.id,
    digest_expected: clean(payload.digest || '', 200) || null,
    digest_actual: digest,
    digest_ok: digestOk,
    writes,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdAuto(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const apply = toBool(args.apply, policy.apply_default === true);
  const embodiment = senseEmbodiment(policy);
  const currentProfile = clean(embodiment?.profile_id || '', 40) || 'unknown';
  const targetProfile = normalizeToken(args['target-profile'] || args.target_profile || currentProfile, 40) || currentProfile;
  const currentRank = profileRank(currentProfile);
  const targetRank = profileRank(targetProfile);
  const action = targetRank > currentRank ? 'expand' : targetRank < currentRank ? 'compress' : 'noop';

  if (action === 'compress') {
    return cmdCompress({ ...args, strict, apply });
  }

  if (action === 'expand') {
    const bundleIds = listBundleIds(policy);
    const latestBundle = bundleIds.length ? bundleIds[bundleIds.length - 1] : null;
    if (!latestBundle) {
      const out = {
        ok: false,
        type: 'compression_transfer_auto',
        ts: nowIso(),
        action,
        current_profile: currentProfile,
        target_profile: targetProfile,
        error: 'no_bundle_available'
      };
      writeJsonAtomic(policy.latest_path, out);
      appendJsonl(policy.receipts_path, out);
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      if (strict) process.exit(1);
      return;
    }
    return cmdExpand({
      ...args,
      strict,
      apply,
      'bundle-id': latestBundle
    });
  }

  const out = {
    ok: true,
    type: 'compression_transfer_auto',
    ts: nowIso(),
    action: 'noop',
    current_profile: currentProfile,
    target_profile: targetProfile
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const bundleIds = listBundleIds(policy);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'compression_transfer_status',
    ts: nowIso(),
    latest,
    bundle_count: bundleIds.length,
    newest_bundle_id: bundleIds.length ? bundleIds[bundleIds.length - 1] : null,
    policy: {
      path: rel(policy.policy_path),
      include_paths: policy.include_paths.map((p: string) => rel(p))
    },
    paths: {
      bundle_dir: rel(policy.bundle_dir),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/compression_transfer_plane.js compress [--strict=1|0]');
  console.log('  node systems/hardware/compression_transfer_plane.js expand --bundle-id=<id> [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/hardware/compression_transfer_plane.js auto [--target-profile=phone|desktop|cluster] [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/hardware/compression_transfer_plane.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'compress') return cmdCompress(args);
  if (cmd === 'expand') return cmdExpand(args);
  if (cmd === 'auto') return cmdAuto(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

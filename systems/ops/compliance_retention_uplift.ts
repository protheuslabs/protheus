#!/usr/bin/env node
'use strict';
export {};

/**
 * compliance_retention_uplift.js
 *
 * RM-131: tiered retention for logs/metrics/security receipts.
 * Tiers (default):
 * - hot <= 90 days (in place)
 * - warm <= 180 days (gzip archive)
 * - cold <= 365 days (gzip archive)
 * - archive > 365 days (gzip archive)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.COMPLIANCE_RETENTION_POLICY_PATH
  ? path.resolve(String(process.env.COMPLIANCE_RETENTION_POLICY_PATH))
  : path.join(ROOT, 'config', 'compliance_retention_policy.json');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return nowIso().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg).startsWith('--')) {
      out._.push(String(arg));
      continue;
    }
    const idx = String(arg).indexOf('=');
    if (idx === -1) out[String(arg).slice(2)] = true;
    else out[String(arg).slice(2, idx)] = String(arg).slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((x) => x && typeof x === 'object');
  } catch {
    return [];
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
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function defaultPolicy() {
  return {
    version: '1.0',
    tiers: {
      hot_days: 90,
      warm_days: 180,
      cold_days: 365
    },
    archive_root: 'state/_retention',
    index_path: 'state/ops/compliance_retention_index.json',
    state_path: 'state/ops/compliance_retention_uplift.json',
    history_path: 'state/ops/compliance_retention_uplift_history.jsonl',
    attestation_dir: 'state/ops/compliance_retention_attestations',
    include_extensions: ['.json', '.jsonl', '.log', '.prom', '.txt'],
    scopes: [
      'state/observability',
      'state/security',
      'state/actuation/receipts',
      'state/autonomy/health_reports',
      'state/autonomy/health_alerts'
    ],
    exclude_contains: ['/state/_retention/']
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const tiers = raw && raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : {};
  const scopesRaw = Array.isArray(raw && raw.scopes) ? raw.scopes : base.scopes;
  const extRaw = Array.isArray(raw && raw.include_extensions) ? raw.include_extensions : base.include_extensions;
  const excludeRaw = Array.isArray(raw && raw.exclude_contains) ? raw.exclude_contains : base.exclude_contains;
  return {
    version: clean(raw && raw.version || base.version, 24) || '1.0',
    tiers: {
      hot_days: clampInt(tiers.hot_days, 1, 3650, base.tiers.hot_days),
      warm_days: clampInt(tiers.warm_days, 2, 3650, base.tiers.warm_days),
      cold_days: clampInt(tiers.cold_days, 3, 3650, base.tiers.cold_days)
    },
    archive_root: resolvePath(raw && raw.archive_root, base.archive_root),
    index_path: resolvePath(raw && raw.index_path, base.index_path),
    state_path: resolvePath(raw && raw.state_path, base.state_path),
    history_path: resolvePath(raw && raw.history_path, base.history_path),
    attestation_dir: resolvePath(raw && raw.attestation_dir, base.attestation_dir),
    include_extensions: Array.from(new Set(extRaw.map((x: unknown) => clean(x, 20).toLowerCase()).filter((x: string) => x.startsWith('.')))),
    scopes: scopesRaw
      .map((x: unknown) => resolvePath(x, 'state'))
      .filter((x: string) => x && x.startsWith(ROOT)),
    exclude_contains: excludeRaw.map((x: unknown) => clean(x, 200)).filter(Boolean)
  };
}

function walkFiles(rootDir: string, includeExtensions: string[], excludeContains: string[]) {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(current, ent.name);
      const rel = relPath(abs);
      if (excludeContains.some((part) => rel.includes(part))) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (includeExtensions.length > 0 && !includeExtensions.includes(ext)) continue;
      out.push(abs);
    }
  }
  return out;
}

function ageDays(filePath: string, nowMs: number) {
  try {
    const st = fs.statSync(filePath);
    return Math.max(0, Math.floor((nowMs - Number(st.mtimeMs || nowMs)) / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}

function classifyTier(age: number, tiers: AnyObj) {
  if (age <= Number(tiers.hot_days || 90)) return 'hot';
  if (age <= Number(tiers.warm_days || 180)) return 'warm';
  if (age <= Number(tiers.cold_days || 365)) return 'cold';
  return 'archive';
}

function gzipToTarget(srcPath: string, dstPath: string) {
  ensureDir(path.dirname(dstPath));
  const buf = fs.readFileSync(srcPath);
  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(dstPath, gz);
}

function runRetention(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const apply = toBool(args.apply, true);
  const strict = toBool(args.strict, false);
  const ts = nowIso();
  const nowMs = Date.parse(ts);

  const tiers = {
    hot: 0,
    warm: 0,
    cold: 0,
    archive: 0
  } as AnyObj;
  const moved = {
    warm: 0,
    cold: 0,
    archive: 0
  } as AnyObj;
  const scanned: string[] = [];
  const indexEntries: AnyObj[] = [];

  for (const scope of policy.scopes) {
    const files = walkFiles(scope, policy.include_extensions, policy.exclude_contains);
    for (const absPath of files) {
      scanned.push(absPath);
      const rel = relPath(absPath);
      const a = ageDays(absPath, nowMs);
      const tier = classifyTier(a, policy.tiers);
      tiers[tier] += 1;
      let storedPath = rel;
      if (tier !== 'hot') {
        storedPath = path.join(relPath(policy.archive_root), tier, `${rel}.gz`).replace(/\\/g, '/');
        const dstAbs = path.join(ROOT, storedPath);
        if (apply) {
          gzipToTarget(absPath, dstAbs);
          fs.unlinkSync(absPath);
          moved[tier] += 1;
        }
      }
      indexEntries.push({
        original_path: rel,
        stored_path: storedPath,
        tier,
        age_days: a
      });
    }
  }

  const indexPayload = {
    schema_id: 'compliance_retention_index',
    schema_version: '1.0',
    updated_at: ts,
    policy_version: policy.version,
    entries: indexEntries.slice(0, 250000)
  };
  writeJsonAtomic(policy.index_path, indexPayload);

  const statePayload = {
    schema_id: 'compliance_retention_uplift',
    schema_version: '1.0',
    updated_at: ts,
    policy_version: policy.version,
    apply,
    scanned_files: scanned.length,
    tiers,
    moved,
    pass: true
  };
  writeJsonAtomic(policy.state_path, statePayload);
  appendJsonl(policy.history_path, {
    ts,
    apply,
    scanned_files: scanned.length,
    tiers,
    moved
  });

  const out = {
    ok: true,
    type: 'compliance_retention_uplift',
    ts,
    apply,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path),
    index_path: relPath(policy.index_path),
    scanned_files: scanned.length,
    tiers,
    moved,
    pass: true
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.pass !== true) process.exit(1);
}

function runAttestation(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const date = clean(args.date || todayUtc(), 10) || todayUtc();
  const month = String(date).slice(0, 7);
  const state = readJson(policy.state_path, {});
  const index = readJson(policy.index_path, {});
  const history = readJsonl(policy.history_path);
  const attestation = {
    schema_id: 'compliance_retention_attestation',
    schema_version: '1.0',
    ts: nowIso(),
    month,
    policy_version: policy.version,
    state_summary: {
      updated_at: state.updated_at || null,
      scanned_files: Number(state.scanned_files || 0),
      tiers: state.tiers || {},
      moved: state.moved || {}
    },
    index_entry_count: Array.isArray(index.entries) ? index.entries.length : 0,
    history_rows: history.length
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(attestation)).digest('hex');
  const outPayload = { ...attestation, digest_sha256: digest };
  const filePath = path.join(policy.attestation_dir, `${month}.json`);
  writeJsonAtomic(filePath, outPayload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'compliance_retention_attestation',
    ts: nowIso(),
    month,
    path: relPath(filePath),
    digest_sha256: digest
  }, null, 2)}\n`);
}

function statusRetention(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = readJson(policy.state_path, null);
  const index = readJson(policy.index_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'compliance_retention_uplift_status',
    ts: nowIso(),
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    index_path: relPath(policy.index_path),
    history_path: relPath(policy.history_path),
    available: !!state,
    state: state && typeof state === 'object' ? state : null,
    index_entry_count: index && Array.isArray(index.entries) ? index.entries.length : 0
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/compliance_retention_uplift.js run [--apply=1]');
  console.log('  node systems/ops/compliance_retention_uplift.js attest [--date=YYYY-MM-DD]');
  console.log('  node systems/ops/compliance_retention_uplift.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 40).toLowerCase();
  if (cmd === 'run') return runRetention(args);
  if (cmd === 'attest') return runAttestation(args);
  if (cmd === 'status') return statusRetention(args);
  usage();
  process.exit(1);
}

main();


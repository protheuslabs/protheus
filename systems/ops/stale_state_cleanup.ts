#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-006
 * Automated stale-state cleanup helper (non-destructive).
 *
 * Usage:
 *   node systems/ops/stale_state_cleanup.js plan [--apply=1] [--policy=<path>] [--max-age-days=N]
 *   node systems/ops/stale_state_cleanup.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.STALE_STATE_CLEANUP_ROOT
  ? path.resolve(process.env.STALE_STATE_CLEANUP_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STALE_STATE_CLEANUP_POLICY_PATH
  ? path.resolve(process.env.STALE_STATE_CLEANUP_POLICY_PATH)
  : path.join(ROOT, 'config', 'stale_state_cleanup_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_age_days: 14,
    roots: ['state', 'tmp', 'logs'],
    allowed_suffixes: ['.json', '.jsonl', '.tmp', '.log', '.ndjson', '.txt'],
    exclude_prefixes: [
      'state/ops/cleanup',
      'state/security',
      'state/autonomy/receipt_dashboard'
    ],
    dry_run_default: true,
    paths: {
      quarantine_dir: 'state/ops/cleanup/quarantine',
      latest_path: 'state/ops/cleanup/latest.json',
      history_path: 'state/ops/cleanup/history.jsonl'
    }
  };
}

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 260).replace(/\\/g, '/');
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    max_age_days: clampInt(raw.max_age_days, 1, 3650, base.max_age_days),
    roots: asStringArray(raw.roots || base.roots),
    allowed_suffixes: asStringArray(raw.allowed_suffixes || base.allowed_suffixes).map((s) => s.toLowerCase()),
    exclude_prefixes: asStringArray(raw.exclude_prefixes || base.exclude_prefixes),
    dry_run_default: raw.dry_run_default !== false,
    paths: {
      quarantine_dir: resolvePath(paths.quarantine_dir, base.paths.quarantine_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function walkFiles(absRoot: string, out: string[] = []) {
  if (!fs.existsSync(absRoot)) return out;
  const entries = fs.readdirSync(absRoot, { withFileTypes: true });
  entries.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  for (const ent of entries) {
    const abs = path.join(absRoot, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function matchesAllowedSuffix(relPath: string, policy: AnyObj) {
  const lower = String(relPath || '').toLowerCase();
  for (const suffix of policy.allowed_suffixes || []) {
    if (!suffix) continue;
    if (lower.endsWith(String(suffix).toLowerCase())) return true;
  }
  return false;
}

function excludedByPrefix(relPath: string, policy: AnyObj) {
  const rp = String(relPath || '').replace(/\\/g, '/');
  for (const prefix of policy.exclude_prefixes || []) {
    const p = String(prefix || '').replace(/\\/g, '/');
    if (!p) continue;
    if (rp === p || rp.startsWith(`${p}/`)) return true;
  }
  return false;
}

function collectCandidates(policy: AnyObj, maxAgeDays: number) {
  const cutoffMs = Date.now() - (Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000);
  const candidates: AnyObj[] = [];

  for (const rootRel of policy.roots || []) {
    const absRoot = resolvePath(rootRel, rootRel);
    for (const absFile of walkFiles(absRoot, [])) {
      const relPath = rel(absFile);
      if (!relPath || relPath.startsWith('../')) continue;
      if (excludedByPrefix(relPath, policy)) continue;
      if (!matchesAllowedSuffix(relPath, policy)) continue;
      let st = null;
      try { st = fs.statSync(absFile); } catch { st = null; }
      if (!st || !Number.isFinite(Number(st.mtimeMs))) continue;
      if (Number(st.mtimeMs) > cutoffMs) continue;
      candidates.push({
        path: relPath,
        size_bytes: Number(st.size || 0),
        mtime_ms: Number(st.mtimeMs || 0)
      });
    }
  }

  candidates.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return candidates;
}

function moveToQuarantine(candidate: AnyObj, quarantineRoot: string) {
  const src = path.join(ROOT, String(candidate.path || ''));
  const dst = path.join(quarantineRoot, String(candidate.path || ''));
  ensureDir(path.dirname(dst));
  fs.renameSync(src, dst);
}

function cmdPlan(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const maxAgeDays = clampInt(args['max-age-days'] || args.max_age_days, 1, 3650, policy.max_age_days);
  const apply = toBool(args.apply, !policy.dry_run_default ? true : false);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const candidates = collectCandidates(policy, maxAgeDays);
  const quarantineRunDir = path.join(policy.paths.quarantine_dir, nowIso().slice(0, 19).replace(/[:T]/g, '-'));
  const moved: string[] = [];

  if (apply) {
    for (const candidate of candidates) {
      moveToQuarantine(candidate, quarantineRunDir);
      moved.push(String(candidate.path || ''));
    }
  }

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'stale_state_cleanup',
    apply,
    max_age_days: maxAgeDays,
    candidate_count: candidates.length,
    candidates,
    moved_count: moved.length,
    moved,
    quarantine_run_dir: apply ? rel(quarantineRunDir) : null,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    apply,
    max_age_days: maxAgeDays,
    candidate_count: out.candidate_count,
    moved_count: out.moved_count
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'stale_state_cleanup_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/stale_state_cleanup.js plan [--apply=1] [--max-age-days=N] [--policy=<path>]');
  console.log('  node systems/ops/stale_state_cleanup.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'plan'
      ? cmdPlan(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
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
  collectCandidates,
  cmdPlan,
  cmdStatus
};

#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'rust_hotpath_inventory_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 24).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_hotpath_inventory.js run [--policy=<path>]');
  console.log('  node systems/ops/rust_hotpath_inventory.js status [--policy=<path>]');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const fallback = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    paths: {
      latest_path: 'state/ops/rust_hotpath_inventory/latest.json',
      history_path: 'state/ops/rust_hotpath_inventory/history.jsonl'
    },
    scan: {
      roots: ['systems', 'lib'],
      include_extensions: ['.ts', '.rs'],
      exclude_dirs: ['.git', 'node_modules', 'dist', 'state', 'tmp', 'target']
    },
    report: {
      top_directories: 15,
      top_files: 30,
      milestones: [15, 25, 35, 50]
    }
  };
  const src = readJson(policyPath, fallback) || fallback;
  const scan = src.scan && typeof src.scan === 'object' ? src.scan : {};
  const pathsObj = src.paths && typeof src.paths === 'object' ? src.paths : {};
  const report = src.report && typeof src.report === 'object' ? src.report : {};
  return {
    version: cleanText(src.version || fallback.version, 40) || fallback.version,
    enabled: toBool(src.enabled, true),
    strict_default: toBool(src.strict_default, true),
    paths: {
      latest_path: path.resolve(ROOT, cleanText(pathsObj.latest_path || fallback.paths.latest_path, 260)),
      history_path: path.resolve(ROOT, cleanText(pathsObj.history_path || fallback.paths.history_path, 260))
    },
    scan: {
      roots: Array.isArray(scan.roots) ? scan.roots.map((v: unknown) => cleanText(v, 120)).filter(Boolean) : fallback.scan.roots,
      include_extensions: Array.isArray(scan.include_extensions) ? scan.include_extensions.map((v: unknown) => cleanText(v, 20)).filter(Boolean) : fallback.scan.include_extensions,
      exclude_dirs: Array.isArray(scan.exclude_dirs) ? scan.exclude_dirs.map((v: unknown) => cleanText(v, 80)).filter(Boolean) : fallback.scan.exclude_dirs
    },
    report: {
      top_directories: Math.max(1, Number(report.top_directories || fallback.report.top_directories)),
      top_files: Math.max(1, Number(report.top_files || fallback.report.top_files)),
      milestones: Array.isArray(report.milestones) ? report.milestones.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0 && v <= 100) : fallback.report.milestones
    }
  };
}

function shouldSkipPath(absPath: string, excludeDirs: string[]) {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return true;
  const chunks = rel.split('/');
  return chunks.some((chunk) => excludeDirs.includes(chunk));
}

function collectFiles(policy: AnyObj) {
  const files: string[] = [];
  const includeExt = new Set((policy.scan.include_extensions || []).map((ext: string) => ext.toLowerCase()));
  const excludeDirs = new Set((policy.scan.exclude_dirs || []).map((v: string) => v));

  function walk(absDir: string) {
    if (!fs.existsSync(absDir)) return;
    if (shouldSkipPath(absDir, Array.from(excludeDirs))) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, String(entry.name || ''));
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(abs).toLowerCase();
      if (!includeExt.has(ext)) continue;
      if (shouldSkipPath(abs, Array.from(excludeDirs))) continue;
      files.push(abs);
    }
  }

  for (const rootRel of policy.scan.roots || []) {
    walk(path.resolve(ROOT, rootRel));
  }
  return files;
}

function countLines(filePath: string) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return 0;
    let lines = 1;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
  } catch {
    return 0;
  }
}

function relativeDirKey(filePath: string) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.length <= 1) return rel;
  return `${parts[0]}/${parts[1]}`;
}

function runInventory(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    return {
      ok: true,
      type: 'rust_hotpath_inventory',
      ts: nowIso(),
      enabled: false,
      policy_version: policy.version,
      policy_path: path.relative(ROOT, policyPath).replace(/\\/g, '/')
    };
  }

  const files = collectFiles(policy);
  const byDir: Record<string, number> = {};
  const byFile: Array<{ path: string, lines: number, language: string }> = [];
  let tsLines = 0;
  let rsLines = 0;

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const lines = countLines(abs);
    const ext = path.extname(abs).toLowerCase();
    const lang = ext === '.rs' ? 'rs' : ext === '.ts' ? 'ts' : ext.replace('.', '');
    byFile.push({ path: rel, lines, language: lang });
    const key = relativeDirKey(abs);
    byDir[key] = (byDir[key] || 0) + lines;
    if (lang === 'ts') tsLines += lines;
    if (lang === 'rs') rsLines += lines;
  }

  byFile.sort((a, b) => Number(b.lines) - Number(a.lines) || a.path.localeCompare(b.path));
  const dirs = Object.entries(byDir)
    .map(([key, lines]) => ({ key, lines }))
    .sort((a, b) => Number(b.lines) - Number(a.lines) || a.key.localeCompare(b.key));

  const total = tsLines + rsLines;
  const rustPct = total > 0 ? Number(((rsLines / total) * 100).toFixed(3)) : 0;
  const milestones = (policy.report.milestones || []).map((targetPct: number) => {
    const targetRatio = targetPct / 100;
    const x = targetRatio >= 1
      ? Number.POSITIVE_INFINITY
      : Math.max(0, ((targetRatio * tsLines) - ((1 - targetRatio) * rsLines)) / (1 - targetRatio));
    return {
      target_pct: targetPct,
      additional_rs_lines_needed: Number.isFinite(x) ? Math.ceil(x) : null
    };
  });

  const payload = {
    ok: true,
    type: 'rust_hotpath_inventory',
    ts: nowIso(),
    policy_version: policy.version,
    policy_path: path.relative(ROOT, policyPath).replace(/\\/g, '/'),
    totals: {
      tracked_ts_lines: tsLines,
      tracked_rs_lines: rsLines,
      rust_percent: rustPct
    },
    top_directories: dirs.slice(0, policy.report.top_directories),
    top_files: byFile.slice(0, policy.report.top_files),
    milestones
  };

  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.history_path, payload);
  return payload;
}

function status(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.paths.latest_path, null);
  return {
    ok: latest && latest.ok === true,
    type: 'rust_hotpath_inventory_status',
    ts: nowIso(),
    policy_version: policy.version,
    latest_path: path.relative(ROOT, policy.paths.latest_path).replace(/\\/g, '/'),
    history_path: path.relative(ROOT, policy.paths.history_path).replace(/\\/g, '/'),
    latest
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 40) || 'run';
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  if (cmd === 'run') {
    const out = runInventory(policyPath);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const out = status(policyPath);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runInventory,
  status
};

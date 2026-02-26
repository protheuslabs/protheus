#!/usr/bin/env node
'use strict';

/**
 * architecture_guard.js
 *
 * Detect specialization leakage in generic system layer.
 *
 * Usage:
 *   node systems/security/architecture_guard.js run [--strict] [--policy=/abs/path.json]
 *   node systems/security/architecture_guard.js --help
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'architecture_guard_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/architecture_guard.js run [--strict] [--policy=/abs/path.json]');
  console.log('  node systems/security/architecture_guard.js --help');
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

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map(x => String(x || '').trim()).filter(Boolean)));
}

function escapeRegExp(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenRegex(token) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;
  const escaped = escapeRegExp(raw);
  // Treat "_" and "-" as separators so "moltbook_publish" matches "moltbook".
  if (/^[a-z0-9_-]+$/i.test(raw)) return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return new RegExp(escaped, 'i');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeTokenOverrides(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const [k, arr] of Object.entries(v)) {
    const rule = String(k || '').trim().replace(/\\/g, '/');
    if (!rule) continue;
    const tokens = asStringArray(arr).map(x => String(x || '').toLowerCase());
    if (tokens.length <= 0) continue;
    out[rule] = tokens;
  }
  return out;
}

function loadPolicy(policyPath) {
  const fallback = {
    version: '1.0-fallback',
    target_roots: ['systems'],
    file_extensions: ['.js'],
    exclude_paths: ['systems/security/architecture_guard.js'],
    banned_tokens: ['moltbook', 'moltstack', 'twitter', 'x.com', '/api/v1/'],
    allow_paths: [],
    allow_token_overrides: {}
  };
  const src = readJsonSafe(policyPath, {});
  return {
    ...fallback,
    ...src,
    target_roots: asStringArray(src.target_roots || fallback.target_roots),
    file_extensions: asStringArray(src.file_extensions || fallback.file_extensions).map(x => x.toLowerCase()),
    exclude_paths: asStringArray(src.exclude_paths || fallback.exclude_paths),
    banned_tokens: asStringArray(src.banned_tokens || fallback.banned_tokens).map(x => x.toLowerCase()),
    allow_paths: asStringArray(src.allow_paths || fallback.allow_paths),
    allow_token_overrides: normalizeTokenOverrides(src.allow_token_overrides || fallback.allow_token_overrides)
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
  for (const e of entries) {
    const abs = path.join(dirPath, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function isPathMatch(rel, rule) {
  const r = String(rule || '').trim().replace(/\\/g, '/');
  if (!r) return false;
  if (r.endsWith('/**')) return rel.startsWith(r.slice(0, -3));
  return rel === r;
}

function shouldSkip(rel, policy) {
  for (const rule of policy.exclude_paths) {
    if (isPathMatch(rel, rule)) return true;
  }
  return false;
}

function isAllowed(rel, policy) {
  for (const rule of policy.allow_paths) {
    if (isPathMatch(rel, rule)) return true;
  }
  return false;
}

function allowedTokensForPath(rel, policy) {
  const out = new Set();
  const overrides = policy && policy.allow_token_overrides && typeof policy.allow_token_overrides === 'object'
    ? policy.allow_token_overrides
    : {};
  for (const [rule, tokens] of Object.entries(overrides)) {
    if (!isPathMatch(rel, rule)) continue;
    for (const token of asStringArray(tokens)) {
      out.add(String(token || '').toLowerCase());
    }
  }
  return out;
}

function scanPolicy(policy) {
  const files = [];
  for (const rootRel of policy.target_roots) {
    const absRoot = path.resolve(REPO_ROOT, rootRel);
    for (const f of walkFiles(absRoot, [])) {
      const rel = relPath(f);
      if (shouldSkip(rel, policy)) continue;
      const ext = path.extname(rel).toLowerCase();
      if (!policy.file_extensions.includes(ext)) continue;
      files.push(f);
    }
  }
  files.sort((a, b) => relPath(a).localeCompare(relPath(b)));

  const violations = [];
  const tokenMatchers = policy.banned_tokens
    .map((token) => ({ token, rx: tokenRegex(token) }))
    .filter((ent) => ent && ent.rx);
  for (const absFile of files) {
    const rel = relPath(absFile);
    const allowed = isAllowed(rel, policy);
    if (allowed) continue;
    const allowTokens = allowedTokensForPath(rel, policy);
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '');
      for (const ent of tokenMatchers) {
        const token = String(ent.token || '').toLowerCase();
        if (!token) continue;
        if (allowTokens.has(token)) continue;
        if (!ent.rx.test(line)) continue;
        violations.push({
          file: rel,
          line: i + 1,
          token,
          sample: line.trim().slice(0, 160)
        });
      }
    }
  }

  return {
    policy_version: policy.version,
    scanned_files: files.length,
    target_roots: policy.target_roots,
    violations,
    violation_count: violations.length
  };
}

function cmdRun(args) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const strict = args.strict === true;
  const policy = loadPolicy(policyPath);
  const scan = scanPolicy(policy);
  const out = {
    ok: scan.violation_count === 0,
    mode: strict ? 'strict' : 'audit',
    ts: new Date().toISOString(),
    policy_path: policyPath,
    ...scan
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && scan.violation_count > 0) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  cmdRun(args);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  scanPolicy
};
export {};

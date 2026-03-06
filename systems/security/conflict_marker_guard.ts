#!/usr/bin/env node
'use strict';

/**
 * conflict_marker_guard.js
 *
 * Detect unresolved git merge-conflict markers across tracked code/docs/config scopes.
 *
 * Usage:
 *   node systems/security/conflict_marker_guard.js run [--strict=1|0] [--staged=1|0] [--files=a,b,c]
 *   node systems/security/conflict_marker_guard.js status
 *   node systems/security/conflict_marker_guard.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CONFLICT_MARKER_GUARD_POLICY_PATH
  ? path.resolve(process.env.CONFLICT_MARKER_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'conflict_marker_guard_policy.json');
const STATE_DIR = path.join(ROOT, 'state', 'ops', 'conflict_marker_guard');
const STATE_LATEST = path.join(STATE_DIR, 'latest.json');
const STATE_HISTORY = path.join(STATE_DIR, 'history.jsonl');
const MARKER_RE = /^\s*(<<<<<<<|=======|>>>>>>>)(?:\s|$)/;

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/conflict_marker_guard.js run [--strict=1|0] [--staged=1|0] [--files=a,b,c]');
  console.log('  node systems/security/conflict_marker_guard.js status');
  console.log('  node systems/security/conflict_marker_guard.js --help');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx < 0) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizePath(v: unknown) {
  return String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function readJsonSafe(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function runGit(args: string[]) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .map(normalizePath)
    .filter(Boolean);
}

function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  return {
    schema_version: String(raw.schema_version || '1.0'),
    prefixes: Array.isArray(scope.prefixes) ? scope.prefixes.map(normalizePath).filter(Boolean) : [],
    extensions: Array.isArray(scope.extensions)
      ? scope.extensions.map((row: unknown) => String(row || '').trim().toLowerCase()).filter(Boolean)
      : [],
    exclude_paths: Array.isArray(scope.exclude_paths) ? scope.exclude_paths.map(normalizePath).filter(Boolean) : [],
    max_violations_reported: Math.max(1, Number(raw.max_violations_reported || 200) || 200)
  };
}

function collectFiles(args: AnyObj) {
  const explicit = normalizePath(args.files);
  if (explicit) {
    return Array.from(new Set(explicit.split(',').map(normalizePath).filter(Boolean))).sort();
  }
  if (boolFlag(args.staged, false)) {
    return Array.from(new Set(runGit(['diff', '--name-only', '--cached']))).sort();
  }
  return Array.from(new Set(runGit(['ls-files']))).sort();
}

function inScope(relPath: string, policy: AnyObj) {
  const p = normalizePath(relPath);
  if (!p) return false;
  if (policy.exclude_paths.includes(p)) return false;
  if (!policy.prefixes.some((prefix: string) => p === prefix || p.startsWith(prefix))) return false;
  if (!Array.isArray(policy.extensions) || policy.extensions.length === 0) return true;
  const ext = path.extname(p).toLowerCase();
  return policy.extensions.includes(ext);
}

function scanFile(relPath: string) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return [];
  let src = '';
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const out: AnyObj[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const m = line.match(MARKER_RE);
    if (!m) continue;
    out.push({
      file: relPath,
      line: i + 1,
      marker: String(m[1] || ''),
      sample: line.trim().slice(0, 180)
    });
  }
  return out;
}

function statePaths() {
  return {
    latest: path.relative(ROOT, STATE_LATEST),
    history: path.relative(ROOT, STATE_HISTORY)
  };
}

function writeState(payload: AnyObj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_LATEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.appendFileSync(STATE_HISTORY, `${JSON.stringify({
    ts: payload.ts,
    ok: payload.ok === true,
    scoped_files: Number(payload.scoped_files || 0),
    violations_count: Number(payload.violations_count || 0)
  })}\n`, 'utf8');
}

function runGuard(args: AnyObj = {}) {
  const strict = boolFlag(args.strict, false);
  const policy = loadPolicy();
  const files = collectFiles(args);
  const scoped = files.filter((file) => inScope(file, policy));
  const violations = scoped.flatMap((file) => scanFile(file));
  const details = violations.slice(0, policy.max_violations_reported);
  const uniqueFiles = Array.from(new Set(violations.map((row) => row.file))).sort();
  const out = {
    schema_id: 'conflict_marker_guard',
    schema_version: '1.0',
    ts: nowIso(),
    ok: violations.length === 0,
    strict,
    policy_path: path.relative(ROOT, POLICY_PATH),
    policy_version: policy.schema_version,
    tracked_files: files.length,
    scoped_files: scoped.length,
    violations_count: violations.length,
    violations: details,
    remediation: violations.length === 0
      ? []
      : [
        'Remove unresolved merge markers and keep only the intended final content.',
        'Re-run: node systems/security/conflict_marker_guard.js run --strict=1',
        `Affected files: ${uniqueFiles.join(', ')}`
      ],
    state_paths: statePaths()
  };
  writeState(out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
  return out;
}

function cmdStatus() {
  if (!fs.existsSync(STATE_LATEST)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, STATE_LATEST)
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(STATE_LATEST, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return runGuard(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  runGuard
};

export {};

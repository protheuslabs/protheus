#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

function resolveRepoRoot(startDir: string) {
  let dir = path.resolve(startDir);
  while (true) {
    const pkg = path.join(dir, 'package.json');
    const cargo = path.join(dir, 'Cargo.toml');
    const clientDir = path.join(dir, 'client');
    if (fs.existsSync(pkg) && (fs.existsSync(cargo) || fs.existsSync(clientDir))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(__dirname, '..', '..');
    dir = parent;
  }
}

const ROOT = resolveRepoRoot(__dirname);
const CLIENT_ROOT = fs.existsSync(path.join(ROOT, 'client')) ? path.join(ROOT, 'client') : ROOT;
const SPEC_PATH = process.env.FORMAL_INVARIANT_SPEC_PATH
  ? path.resolve(process.env.FORMAL_INVARIANT_SPEC_PATH)
  : path.join(CLIENT_ROOT, 'config', 'formal_invariants.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/formal_invariant_engine.js run [--strict=1|0]');
  console.log('  node systems/security/formal_invariant_engine.js status');
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

function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolveWorkspacePath(raw: unknown) {
  const p = cleanText(raw, 320);
  if (!p) return null;
  const rewrite = (input: string) => {
    const norm = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm) return norm;
    if (norm === 'state' || norm.startsWith('state/')) {
      const suffix = norm === 'state' ? '' : norm.slice('state/'.length);
      return path.join('client', 'local', 'state', suffix);
    }
    if (norm === 'client/state' || norm.startsWith('client/state/')) {
      const suffix = norm === 'client/state' ? '' : norm.slice('client/state/'.length);
      return path.join('client', 'local', 'state', suffix);
    }
    return norm;
  };
  if (path.isAbsolute(p)) return p;
  return path.join(ROOT, rewrite(p));
}

function getPathValue(src: AnyObj, dotPathRaw: unknown) {
  const dotPath = cleanText(dotPathRaw, 240);
  if (!dotPath) return undefined;
  const parts = dotPath.split('.').map((row) => row.trim()).filter(Boolean);
  let cur: any = src;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function evalInvariant(spec: AnyObj) {
  const id = normalizeToken(spec.id || '', 80) || `inv_${Math.random().toString(36).slice(2, 8)}`;
  const type = normalizeToken(spec.type || '', 80);
  const filePath = resolveWorkspacePath(spec.path);
  if (!filePath) {
    return { id, ok: false, reason: 'path_missing' };
  }
  if (!fs.existsSync(filePath)) {
    return { id, ok: false, reason: 'path_not_found', path: path.relative(ROOT, filePath).replace(/\\/g, '/') };
  }

  if (type === 'file_contains_all') {
    const text = readText(filePath);
    const patterns = Array.isArray(spec.patterns) ? spec.patterns : [];
    const missing = patterns
      .map((row: unknown) => cleanText(row, 160))
      .filter(Boolean)
      .filter((pattern: string) => !text.includes(pattern));
    return {
      id,
      ok: missing.length === 0,
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      missing_patterns: missing
    };
  }

  const json = readJson(filePath, {});
  const value = getPathValue(json, spec.json_path);
  if (type === 'json_path_exists') {
    return {
      id,
      ok: value !== undefined,
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      json_path: cleanText(spec.json_path, 160)
    };
  }
  if (type === 'json_path_equals') {
    const expected = spec.value;
    return {
      id,
      ok: JSON.stringify(value) === JSON.stringify(expected),
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      json_path: cleanText(spec.json_path, 160),
      expected,
      actual: value
    };
  }
  if (type === 'json_path_gte') {
    const expected = Number(spec.value);
    const actual = Number(value);
    const ok = Number.isFinite(expected) && Number.isFinite(actual) && actual >= expected;
    return {
      id,
      ok,
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      json_path: cleanText(spec.json_path, 160),
      expected,
      actual
    };
  }
  if (type === 'json_path_includes') {
    const expected = String(spec.value);
    const arr = Array.isArray(value) ? value : [];
    const normalized = new Set(arr.map((row: unknown) => String(row)));
    return {
      id,
      ok: normalized.has(expected),
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      json_path: cleanText(spec.json_path, 160),
      expected,
      actual_count: arr.length
    };
  }
  if (type === 'json_path_one_of') {
    const options = Array.isArray(spec.values) ? spec.values : [];
    const ok = options.some((row) => JSON.stringify(row) === JSON.stringify(value));
    return {
      id,
      ok,
      type,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      json_path: cleanText(spec.json_path, 160),
      options,
      actual: value
    };
  }
  return {
    id,
    ok: false,
    type,
    reason: 'unknown_invariant_type'
  };
}

function loadSpec() {
  const base = {
    schema_id: 'formal_invariants_spec',
    schema_version: '1.0',
    state_path: 'client/local/state/security/formal_invariant_engine/latest.json',
    history_path: 'client/local/state/security/formal_invariant_engine/history.jsonl',
    invariants: []
  };
  const raw = readJson(SPEC_PATH, base);
  return {
    schema_id: 'formal_invariants_spec',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    state_path: resolveWorkspacePath(raw.state_path || base.state_path) || path.join(ROOT, base.state_path),
    history_path: resolveWorkspacePath(raw.history_path || base.history_path) || path.join(ROOT, base.history_path),
    invariants: Array.isArray(raw.invariants) ? raw.invariants : []
  };
}

function runEngine() {
  const spec = loadSpec();
  const checks = spec.invariants.map((row: AnyObj) => evalInvariant(row && typeof row === 'object' ? row : {}));
  const payload = {
    schema_id: 'formal_invariant_engine_result',
    schema_version: '1.0',
    ts: nowIso(),
    ok: checks.every((row: AnyObj) => row.ok === true),
    total_invariants: checks.length,
    failed_invariants: checks.filter((row: AnyObj) => row.ok !== true).length,
    checks
  };
  writeJsonAtomic(spec.state_path, payload);
  appendJsonl(spec.history_path, payload);
  return payload;
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runEngine();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus() {
  const spec = loadSpec();
  if (!fs.existsSync(spec.state_path)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, spec.state_path).replace(/\\/g, '/')
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(spec.state_path, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

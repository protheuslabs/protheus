#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-008
 * Repo hygiene guard: block generated/runtime artifacts from staged diffs.
 *
 * Usage:
 *   node systems/ops/repo_hygiene_generated_guard.js check [--strict=1|0] [--policy=<path>] [--staged-file=<path> ...]
 *   node systems/ops/repo_hygiene_generated_guard.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.REPO_HYGIENE_GUARD_ROOT
  ? path.resolve(process.env.REPO_HYGIENE_GUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.REPO_HYGIENE_GUARD_POLICY_PATH
  ? path.resolve(process.env.REPO_HYGIENE_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'repo_hygiene_generated_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [], staged_file: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      const key = tok.slice(2, eq);
      const value = tok.slice(eq + 1);
      if (key === 'staged-file' || key === 'staged_file') {
        out.staged_file.push(value);
      } else {
        out[key] = value;
      }
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if ((key === 'staged-file' || key === 'staged_file') && next != null && !String(next).startsWith('--')) {
      out.staged_file.push(String(next));
      i += 1;
      continue;
    }
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
    blocked_globs: [
      'state/**',
      'tmp/**',
      'logs/**',
      'dist/**'
    ],
    allow_globs: [
      'state/README.md',
      'state/**/.gitkeep'
    ],
    outputs: {
      latest_path: 'local/state/ops/repo_hygiene_generated_guard/latest.json',
      history_path: 'local/state/ops/repo_hygiene_generated_guard/history.jsonl'
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
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    blocked_globs: asStringArray(raw.blocked_globs || base.blocked_globs),
    allow_globs: asStringArray(raw.allow_globs || base.allow_globs),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function globToRegex(glob: string) {
  const normalized = String(glob || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const marker = '__GLOBSTAR__';
  const escaped = normalized
    .split('**')
    .join(marker)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(marker, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(target: string, globs: string[]) {
  const relPath = String(target || '').replace(/\\/g, '/').replace(/^\/+/, '');
  for (const g of globs || []) {
    if (!g) continue;
    const rx = globToRegex(g);
    if (rx.test(relPath)) return g;
  }
  return null;
}

function stagedFilesFromGit() {
  const run = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (run.status !== 0) {
    throw new Error(cleanText(run.stderr || run.stdout || 'failed_to_read_staged_files', 260));
  }
  return String(run.stdout || '')
    .split(/\r?\n/)
    .map((line) => cleanText(line, 520).replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter(Boolean);
}

function cmdCheck(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const strict = toBool(args.strict, true);
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const cliStaged = asStringArray(args.staged_file || []);
  const staged = cliStaged.length ? cliStaged : stagedFilesFromGit();

  const violations: AnyObj[] = [];
  for (const file of staged) {
    const blockedBy = matchesAnyGlob(file, policy.blocked_globs);
    if (!blockedBy) continue;
    const allowedBy = matchesAnyGlob(file, policy.allow_globs);
    if (allowedBy) continue;
    violations.push({ path: file, blocked_by: blockedBy });
  }

  const out = {
    ok: violations.length === 0,
    ts: nowIso(),
    type: 'repo_hygiene_generated_guard',
    strict,
    staged_count: staged.length,
    violation_count: violations.length,
    violations,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    strict,
    staged_count: out.staged_count,
    violation_count: out.violation_count,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'repo_hygiene_generated_guard_status',
    latest: readJson(policy.outputs.latest_path, null),
    latest_path: rel(policy.outputs.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/repo_hygiene_generated_guard.js check [--strict=1|0] [--policy=<path>] [--staged-file=<path> ...]');
  console.log('  node systems/ops/repo_hygiene_generated_guard.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'check'
      ? cmdCheck(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'check' && toBool(args.strict, true) && out.ok !== true) process.exit(1);
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
  matchesAnyGlob,
  cmdCheck,
  cmdStatus
};

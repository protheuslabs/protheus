#!/usr/bin/env node
'use strict';

/**
 * repo_hygiene_guard.js
 *
 * Prevent generated/runtime artifacts from being merged.
 *
 * Usage:
 *   node systems/security/repo_hygiene_guard.js run [--strict] [--staged] [--base-ref=main] [--files=a,b,c]
 *   node systems/security/repo_hygiene_guard.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.REPO_HYGIENE_POLICY_PATH
  ? path.resolve(process.env.REPO_HYGIENE_POLICY_PATH)
  : path.join(ROOT, 'config', 'repo_hygiene_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/repo_hygiene_guard.js run [--strict] [--staged] [--base-ref=main] [--files=a,b,c]');
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

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizePath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegex(glob) {
  const s = normalizePath(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${s}$`);
}

function loadPolicy() {
  const raw = readJsonSafe(POLICY_PATH, {});
  const blockedPrefixes = Array.isArray(raw.blocked_prefixes) ? raw.blocked_prefixes.map(normalizePath).filter(Boolean) : [];
  const blockedGlobs = Array.isArray(raw.blocked_globs) ? raw.blocked_globs.map(normalizePath).filter(Boolean) : [];
  const allowPrefixes = Array.isArray(raw.allow_prefixes) ? raw.allow_prefixes.map(normalizePath).filter(Boolean) : [];
  const allowGlobs = Array.isArray(raw.allow_globs) ? raw.allow_globs.map(normalizePath).filter(Boolean) : [];
  return {
    blocked_prefixes: blockedPrefixes,
    blocked_globs: blockedGlobs,
    blocked_regex: blockedGlobs.map(globToRegex),
    allow_prefixes: allowPrefixes,
    allow_globs: allowGlobs,
    allow_regex: allowGlobs.map(globToRegex)
  };
}

function runGit(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map(normalizePath).filter(Boolean);
}

function changedFiles(args) {
  const explicit = String(args.files || '').trim();
  if (explicit) {
    return explicit.split(',').map(normalizePath).filter(Boolean);
  }

  if (args.staged === true) {
    return runGit(['diff', '--name-only', '--cached']);
  }

  const baseRef = String(args['base-ref'] || args.base_ref || process.env.GITHUB_BASE_REF || '').trim();
  if (baseRef) {
    const remoteRef = baseRef.startsWith('origin/') ? baseRef : `origin/${baseRef}`;
    const rows = runGit(['diff', '--name-only', `${remoteRef}...HEAD`]);
    if (rows.length) return rows;
  }

  const recent = runGit(['diff', '--name-only', 'HEAD~1..HEAD']);
  if (recent.length) return recent;

  return runGit(['diff', '--name-only', '--cached']);
}

function matchesPrefix(filePath, prefixes) {
  for (const pref of prefixes) {
    if (filePath === pref || filePath.startsWith(pref)) return true;
  }
  return false;
}

function matchesRegex(filePath, regexes) {
  for (const re of regexes) {
    if (re.test(filePath)) return true;
  }
  return false;
}

function evaluate(files, policy) {
  const violations = [];
  for (const raw of files) {
    const file = normalizePath(raw);
    if (!file) continue;

    const allowed = matchesPrefix(file, policy.allow_prefixes)
      || matchesRegex(file, policy.allow_regex);
    if (allowed) continue;

    const blocked = matchesPrefix(file, policy.blocked_prefixes)
      || matchesRegex(file, policy.blocked_regex);
    if (!blocked) continue;

    violations.push(file);
  }
  return violations.sort();
}

function cmdRun(args) {
  const policy = loadPolicy();
  const files = changedFiles(args);
  const violations = evaluate(files, policy);
  const strict = args.strict === true;
  const out = {
    ok: violations.length === 0,
    type: 'repo_hygiene_guard',
    strict,
    checked_files: files.length,
    violations: violations.length,
    violating_files: violations
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && violations.length > 0) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }

  if (cmd === 'run') {
    cmdRun(args);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'repo_hygiene_guard_failed') }) + '\n');
    process.exit(1);
  }
}
export {};

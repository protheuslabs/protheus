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
  console.log('  node systems/security/repo_hygiene_guard.js run [--strict] [--staged] [--base-ref=main] [--files=a,b,c] [--allow-ts-pair-drift] [--allow-new-js-twins]');
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
  const allowNewJsTwinExact = Array.isArray(raw.allow_new_js_twins)
    ? raw.allow_new_js_twins.map(normalizePath).filter(Boolean)
    : [];
  const allowNewJsTwinPrefixes = Array.isArray(raw.allow_new_js_twin_prefixes)
    ? raw.allow_new_js_twin_prefixes.map(normalizePath).filter(Boolean)
    : [];
  const allowNewJsTwinGlobs = Array.isArray(raw.allow_new_js_twin_globs)
    ? raw.allow_new_js_twin_globs.map(normalizePath).filter(Boolean)
    : [];
  return {
    blocked_prefixes: blockedPrefixes,
    blocked_globs: blockedGlobs,
    blocked_regex: blockedGlobs.map(globToRegex),
    allow_prefixes: allowPrefixes,
    allow_globs: allowGlobs,
    allow_regex: allowGlobs.map(globToRegex),
    allow_new_js_twin_exact: allowNewJsTwinExact,
    allow_new_js_twin_prefixes: allowNewJsTwinPrefixes,
    allow_new_js_twin_globs: allowNewJsTwinGlobs,
    allow_new_js_twin_regex: allowNewJsTwinGlobs.map(globToRegex)
  };
}

function runGit(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map(normalizePath).filter(Boolean);
}

function changedFiles(args) {
  return changedFileRows(args).map((row) => row.file);
}

function normalizeStatus(code) {
  const s = String(code || '').trim().toUpperCase();
  if (!s) return 'M';
  const first = s[0];
  return /[ACDMRTUX?]/.test(first) ? first : 'M';
}

function parseNameStatusLines(lines) {
  return (lines || []).map((line) => {
    const parts = String(line || '').split('\t');
    const status = normalizeStatus(parts[0]);
    const file = normalizePath(parts[parts.length - 1]);
    return { file, status };
  }).filter((row) => !!row.file);
}

function changedFileRows(args) {
  const explicit = String(args.files || '').trim();
  if (explicit) {
    return explicit
      .split(',')
      .map(normalizePath)
      .filter(Boolean)
      .map((file) => ({ file, status: 'M' }));
  }

  if (args.staged === true) {
    return parseNameStatusLines(runGit(['diff', '--name-status', '--cached']));
  }

  const baseRef = String(args['base-ref'] || args.base_ref || process.env.GITHUB_BASE_REF || '').trim();
  if (baseRef) {
    const remoteRef = baseRef.startsWith('origin/') ? baseRef : `origin/${baseRef}`;
    const rows = parseNameStatusLines(runGit(['diff', '--name-status', `${remoteRef}...HEAD`]));
    if (rows.length) return rows;
  }

  const recent = parseNameStatusLines(runGit(['diff', '--name-status', 'HEAD~1..HEAD']));
  if (recent.length) return recent;

  return parseNameStatusLines(runGit(['diff', '--name-status', '--cached']));
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

function inTsPairScope(file) {
  return file.startsWith('systems/') || file.startsWith('lib/');
}

function tsPairPath(file) {
  if (file.endsWith('.js')) return file.slice(0, -3) + '.ts';
  if (file.endsWith('.ts')) return file.slice(0, -3) + '.js';
  return null;
}

function evaluateTsPairDrift(files, args) {
  if (args['allow-ts-pair-drift'] === true || String(args.allow_ts_pair_drift || '').trim() === '1') return [];
  const changed = new Set(files.map(normalizePath).filter(Boolean));
  const out = [];
  for (const raw of changed) {
    const file = String(raw || '');
    if (!inTsPairScope(file)) continue;
    if (!(file.endsWith('.js') || file.endsWith('.ts'))) continue;
    const pair = tsPairPath(file);
    if (!pair) continue;
    const pairAbs = path.join(ROOT, pair);
    if (!fs.existsSync(pairAbs)) continue;
    if (changed.has(pair)) continue;
    out.push(`${file}::missing_pair_change:${pair}`);
  }
  return Array.from(new Set(out)).sort();
}

function evaluateNewJsTwinViolations(rows, policy, args) {
  if (args['allow-new-js-twins'] === true || String(args.allow_new_js_twins || '').trim() === '1') return [];
  const out = [];
  for (const row of rows) {
    const file = normalizePath(row && row.file);
    const status = normalizeStatus(row && row.status);
    if (!file || status !== 'A') continue;
    if (!inTsPairScope(file)) continue;
    if (!file.endsWith('.js')) continue;
    const tsPair = tsPairPath(file);
    if (!tsPair || !tsPair.endsWith('.ts')) continue;
    const tsPairAbs = path.join(ROOT, tsPair);
    if (!fs.existsSync(tsPairAbs)) continue;
    const allowed = (policy.allow_new_js_twin_exact || []).includes(file)
      || matchesPrefix(file, policy.allow_new_js_twin_prefixes || [])
      || matchesRegex(file, policy.allow_new_js_twin_regex || []);
    if (allowed) continue;
    out.push(`${file}::new_js_twin_requires_allowlist:${tsPair}`);
  }
  return Array.from(new Set(out)).sort();
}

function cmdRun(args) {
  const policy = loadPolicy();
  const rows = changedFileRows(args);
  const files = rows.map((row) => row.file);
  const violations = evaluate(files, policy);
  const tsPairDrift = evaluateTsPairDrift(files, args);
  const newJsTwins = evaluateNewJsTwinViolations(rows, policy, args);
  const strict = args.strict === true;
  const total = violations.length + tsPairDrift.length + newJsTwins.length;
  const out = {
    ok: total === 0,
    type: 'repo_hygiene_guard',
    strict,
    checked_files: files.length,
    violations: total,
    violating_files: violations,
    ts_pair_drift_violations: tsPairDrift,
    new_js_twin_violations: newJsTwins
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && total > 0) process.exit(1);
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

#!/usr/bin/env node
'use strict';

/**
 * workspace_dump_guard.js
 *
 * Purpose:
 * - Prevent arbitrary source/code dumps into data layers.
 * - Enforce canonical placement for sensory eye collectors.
 *
 * Usage:
 *   node systems/security/workspace_dump_guard.js run [--strict]
 *   node systems/security/workspace_dump_guard.js --help
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_EXTS = new Set(['.js', '.ts', '.py', '.sh']);

const ADAPTIVE_ROOT = path.join(REPO_ROOT, 'adaptive');
const MEMORY_ROOT = path.join(REPO_ROOT, 'memory');
const MEMORY_TOOLS_ROOT = path.join(MEMORY_ROOT, 'tools');
const FORBIDDEN_EYES_COLLECTORS_ROOT = path.join(REPO_ROOT, 'habits', 'scripts', 'eyes_collectors');
const ALLOWED_ADAPTIVE_SOURCE_ROOTS = [
  path.join(REPO_ROOT, 'adaptive', 'sensory', 'eyes', 'collectors')
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/workspace_dump_guard.js run [--strict]');
  console.log('  node systems/security/workspace_dump_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function rel(abs) {
  return path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
}

function hasSourceExt(fileName) {
  return SOURCE_EXTS.has(path.extname(String(fileName || '')).toLowerCase());
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
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dirPath, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function isSubpath(absPath, absRoot) {
  const relPath = path.relative(absRoot, absPath).replace(/\\/g, '/');
  if (!relPath || relPath === '') return true;
  return !relPath.startsWith('../') && relPath !== '..';
}

function evaluate() {
  const violations = [];

  for (const abs of walkFiles(ADAPTIVE_ROOT, [])) {
    if (!hasSourceExt(abs)) continue;
    const allowed = ALLOWED_ADAPTIVE_SOURCE_ROOTS.some((root) => isSubpath(abs, root));
    if (allowed) continue;
    violations.push({
      type: 'adaptive_source_file_forbidden',
      file: rel(abs)
    });
  }

  for (const abs of walkFiles(MEMORY_ROOT, [])) {
    if (!hasSourceExt(abs)) continue;
    if (isSubpath(abs, MEMORY_TOOLS_ROOT)) continue;
    violations.push({
      type: 'memory_source_file_outside_tools_forbidden',
      file: rel(abs)
    });
  }

  for (const abs of walkFiles(FORBIDDEN_EYES_COLLECTORS_ROOT, [])) {
    if (!hasSourceExt(abs)) continue;
    violations.push({
      type: 'eyes_collector_misplaced_under_habits',
      file: rel(abs)
    });
  }

  for (const abs of walkFiles(REPO_ROOT, [])) {
    if (path.dirname(abs) !== REPO_ROOT) continue;
    const base = path.basename(abs);
    if (!/^(temp|debug)[._-].+\.(js|ts|py|sh)$/i.test(base)) continue;
    violations.push({
      type: 'root_temp_debug_source_forbidden',
      file: rel(abs)
    });
  }

  return {
    ok: violations.length === 0,
    checked: {
      adaptive_root: rel(ADAPTIVE_ROOT),
      allowed_adaptive_source_roots: ALLOWED_ADAPTIVE_SOURCE_ROOTS.map(rel),
      memory_root: rel(MEMORY_ROOT),
      forbidden_eyes_collectors_root: rel(FORBIDDEN_EYES_COLLECTORS_ROOT)
    },
    violations
  };
}

function summarize(items) {
  const counts = {};
  for (const it of items || []) {
    const key = String((it && it.type) || 'unknown');
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function run(strict = false) {
  const out = evaluate();
  const payload = {
    ok: out.ok,
    strict: strict === true,
    checked: out.checked,
    violation_counts: summarize(out.violations),
    violations: out.violations
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  if (!payload.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  run(args.strict === true);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluate
};

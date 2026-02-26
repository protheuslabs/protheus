#!/usr/bin/env node
'use strict';

/**
 * memory_layer_guard.js
 *
 * Protect memory-layer files from arbitrary writes.
 * Enforces channelized mutation through memory controllers.
 *
 * Usage:
 *   node systems/memory/memory_layer_guard.js run [--strict] [--policy=/abs/path.json]
 *   node systems/memory/memory_layer_guard.js --help
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'memory_layer_guard_policy.json');

const DIRECT_WRITE_PATTERNS = [
  /\bfs\.(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|rmdirSync)\s*\([^)]*memory\//i,
  /\bfs\.(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|rmdirSync)\s*\([^)]*state\/memory\//i,
  /\bfs\.(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync)\s*\(\s*(?:MEMORY_|POINTER_|DREAM_|CONNECTIONS_|INDEX_|UID_)[A-Z0-9_]*\b/,
  /\bfs\.(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync)\s*\(\s*(?:memoryPath|pointerPath|indexPath|nodePath|dreamPath)\b/,
  /\bappendJsonl\s*\(\s*(?:LEDGER_PATH|POINTERS_PATH|POINTER_INDEX_PATH|DREAM_LEDGER_PATH|CONNECTIONS_PATH|IDLE_DIR)\b/
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memory_layer_guard.js run [--strict] [--policy=/abs/path.json]');
  console.log('  node systems/memory/memory_layer_guard.js --help');
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

function normalizeList(v) {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map((x) => String(x || '').trim()).filter(Boolean)));
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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

function loadPolicy(policyPath) {
  const fallback = {
    version: '1.0-fallback',
    target_roots: ['systems', 'habits', 'lib', 'adaptive'],
    file_extensions: ['.js'],
    exclude_paths: ['systems/memory/memory_layer_guard.js'],
    allow_paths: [
      'systems/memory/eyes_memory_bridge.js',
      'systems/memory/failure_memory_bridge.js',
      'systems/memory/memory_dream.js',
      'systems/memory/idle_dream_cycle.js',
      'systems/memory/uid_connections.js',
      'systems/memory/creative_links.js',
      'systems/adaptive/core/layer_store.js'
    ]
  };
  const raw = readJsonSafe(policyPath, {});
  return {
    ...fallback,
    ...raw,
    target_roots: normalizeList(raw.target_roots || fallback.target_roots),
    file_extensions: normalizeList(raw.file_extensions || fallback.file_extensions).map((x) => x.toLowerCase()),
    exclude_paths: normalizeList(raw.exclude_paths || fallback.exclude_paths),
    allow_paths: normalizeList(raw.allow_paths || fallback.allow_paths)
  };
}

function shouldSkip(rel, rules) {
  for (const r of rules) {
    if (isPathMatch(rel, r)) return true;
  }
  return false;
}

function scanPolicy(policy) {
  const files = [];
  for (const rootRel of policy.target_roots) {
    const absRoot = path.resolve(REPO_ROOT, rootRel);
    for (const abs of walkFiles(absRoot, [])) {
      const rel = relPath(abs);
      if (shouldSkip(rel, policy.exclude_paths)) continue;
      if (!policy.file_extensions.includes(path.extname(rel).toLowerCase())) continue;
      files.push(abs);
    }
  }
  files.sort((a, b) => relPath(a).localeCompare(relPath(b)));

  const violations = [];
  for (const absFile of files) {
    const rel = relPath(absFile);
    if (shouldSkip(rel, policy.allow_paths)) continue;
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '');
      for (const pattern of DIRECT_WRITE_PATTERNS) {
        if (!pattern.test(line)) continue;
        violations.push({
          file: rel,
          line: i + 1,
          rule: String(pattern),
          sample: line.trim().slice(0, 180)
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
  const strict = args.strict === true;
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
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

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
const DEFAULT_POLICY_PATH = process.env.WORKSPACE_DUMP_GUARD_POLICY_PATH
  ? path.resolve(String(process.env.WORKSPACE_DUMP_GUARD_POLICY_PATH))
  : path.join(REPO_ROOT, 'config', 'workspace_dump_guard_policy.json');
const SOURCE_EXTS = new Set(['.js', '.ts', '.py', '.sh']);

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/workspace_dump_guard.js run [--strict] [--policy=<path>]');
  console.log('  node systems/security/workspace_dump_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else {
      const eq = arg.indexOf('=');
      if (eq >= 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else out[arg.slice(2)] = true;
    }
  }
  return out;
}

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function resolvePath(v, fallbackRel) {
  const raw = cleanText(v || fallbackRel, 420);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(REPO_ROOT, raw);
}

function defaultPolicy() {
  return {
    schema_id: 'workspace_dump_guard_policy',
    schema_version: '1.0',
    adaptive_root: 'adaptive',
    memory_root: 'memory',
    memory_tools_root: 'memory/tools',
    forbidden_eyes_collectors_root: 'habits/scripts/eyes_collectors',
    allowed_adaptive_source_roots: [
      'adaptive/sensory/eyes/collectors',
      'adaptive/executive',
      'adaptive/rsi'
    ],
    root_temp_debug_pattern: '^(temp|debug)[._-].+\\.(js|ts|py|sh)$'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const adaptiveRoots = Array.isArray(raw.allowed_adaptive_source_roots)
    ? raw.allowed_adaptive_source_roots
    : base.allowed_adaptive_source_roots;
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    adaptive_root: resolvePath(raw.adaptive_root, base.adaptive_root),
    memory_root: resolvePath(raw.memory_root, base.memory_root),
    memory_tools_root: resolvePath(raw.memory_tools_root, base.memory_tools_root),
    forbidden_eyes_collectors_root: resolvePath(
      raw.forbidden_eyes_collectors_root,
      base.forbidden_eyes_collectors_root
    ),
    allowed_adaptive_source_roots: adaptiveRoots
      .map((row) => resolvePath(row, 'adaptive/sensory/eyes/collectors'))
      .filter(Boolean),
    root_temp_debug_pattern: cleanText(raw.root_temp_debug_pattern || base.root_temp_debug_pattern, 260)
      || base.root_temp_debug_pattern,
    policy_path: path.resolve(policyPath)
  };
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

function evaluate(policy = loadPolicy()) {
  const ADAPTIVE_ROOT = policy.adaptive_root;
  const MEMORY_ROOT = policy.memory_root;
  const MEMORY_TOOLS_ROOT = policy.memory_tools_root;
  const FORBIDDEN_EYES_COLLECTORS_ROOT = policy.forbidden_eyes_collectors_root;
  const ALLOWED_ADAPTIVE_SOURCE_ROOTS = Array.isArray(policy.allowed_adaptive_source_roots)
    ? policy.allowed_adaptive_source_roots
    : [];
  let tempDebugPattern;
  try {
    tempDebugPattern = new RegExp(
      cleanText(policy.root_temp_debug_pattern || '', 260) || '^(temp|debug)[._-].+\\.(js|ts|py|sh)$',
      'i'
    );
  } catch {
    tempDebugPattern = /^(temp|debug)[._-].+\.(js|ts|py|sh)$/i;
  }
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
    if (!tempDebugPattern.test(base)) continue;
    violations.push({
      type: 'root_temp_debug_source_forbidden',
      file: rel(abs)
    });
  }

  return {
    ok: violations.length === 0,
    policy_path: rel(policy.policy_path),
    policy_version: cleanText(policy.schema_version || '1.0', 24) || '1.0',
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

function run(strict = false, policyPath = DEFAULT_POLICY_PATH) {
  const out = evaluate(loadPolicy(policyPath));
  const payload = {
    ok: out.ok,
    strict: strict === true,
    policy_path: out.policy_path,
    policy_version: out.policy_version,
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
  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : DEFAULT_POLICY_PATH;
  run(args.strict === true, policyPath);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluate
};
export {};

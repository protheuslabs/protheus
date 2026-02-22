#!/usr/bin/env node
'use strict';

/**
 * skill_install_enforcer.js
 *
 * Enforce that skill installation flows through approved quarantine wrapper(s).
 *
 * Usage:
 *   node systems/security/skill_install_enforcer.js run [--strict] [--policy=/abs/path.json]
 *   node systems/security/skill_install_enforcer.js --help
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'skill_install_enforcement_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/skill_install_enforcer.js run [--strict] [--policy=/abs/path.json]');
  console.log('  node systems/security/skill_install_enforcer.js --help');
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

function loadPolicy(policyPath) {
  const fallback = {
    version: '1.1-fallback',
    target_roots: ['systems', 'habits', 'skills', 'memory/tools'],
    target_files: ['README.md', 'AGENTS.md'],
    file_extensions: ['.js', '.sh', '.md', '.json'],
    exclude_paths: [
      'systems/security/skill_install_enforcer.js',
      'memory/tools/tests/**'
    ],
    allow_paths: [
      'habits/scripts/install_skill_safe.js',
      'systems/security/skill_quarantine.js',
      'config/skill_install_policy.json'
    ],
    blocked_regexes: [
      '\\bnpx\\s+molthub\\s+install\\b',
      '\\bmolthub\\s+install\\b',
      "\\bspawnSync\\s*\\(\\s*['\\\"]npx['\\\"][\\s\\S]{0,220}['\\\"]molthub['\\\"][\\s\\S]{0,220}['\\\"]install['\\\"]",
      "\\bspawnSync\\s*\\(\\s*['\\\"]molthub['\\\"][\\s\\S]{0,220}['\\\"]install['\\\"]",
      '\\bexec(?:File)?Sync\\s*\\([\\s\\S]{0,260}molthub[\\s\\S]{0,160}install'
    ],
    required_wrapper_path: 'habits/scripts/install_skill_safe.js',
    required_wrapper_markers: ['inspectSpec(', 'verifyPath(', 'trustFiles('],
    required_quarantine_path: 'systems/security/skill_quarantine.js'
  };
  const src = readJsonSafe(policyPath, {});
  return {
    ...fallback,
    ...src,
    target_roots: asStringArray(src.target_roots || fallback.target_roots),
    target_files: asStringArray(src.target_files || fallback.target_files),
    file_extensions: asStringArray(src.file_extensions || fallback.file_extensions).map((x) => x.toLowerCase()),
    exclude_paths: asStringArray(src.exclude_paths || fallback.exclude_paths),
    allow_paths: asStringArray(src.allow_paths || fallback.allow_paths),
    blocked_regexes: asStringArray(src.blocked_regexes || fallback.blocked_regexes),
    required_wrapper_markers: asStringArray(src.required_wrapper_markers || fallback.required_wrapper_markers)
  };
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

function compileRegexes(patterns) {
  const out = [];
  for (const raw of patterns || []) {
    try {
      out.push({ raw, rx: new RegExp(String(raw), 'i') });
    } catch {}
  }
  return out;
}

function lineNoForOffset(text, offset) {
  if (!Number.isFinite(offset) || offset < 0) return 1;
  return String(text || '').slice(0, offset).split('\n').length;
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

  for (const singleRel of policy.target_files) {
    const abs = path.resolve(REPO_ROOT, singleRel);
    const rel = relPath(abs);
    if (!fs.existsSync(abs)) continue;
    if (shouldSkip(rel, policy)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (ext && !policy.file_extensions.includes(ext)) continue;
    files.push(abs);
  }

  const uniqFiles = Array.from(new Set(files.map((x) => path.resolve(x)))).sort();
  const regexes = compileRegexes(policy.blocked_regexes);
  const violations = [];

  for (const absFile of uniqFiles) {
    const rel = relPath(absFile);
    if (isAllowed(rel, policy)) continue;
    const text = fs.readFileSync(absFile, 'utf8');
    for (const ent of regexes) {
      const rx = ent.rx;
      rx.lastIndex = 0;
      let m = rx.exec(text);
      while (m) {
        const idx = Number(m.index || 0);
        const line = lineNoForOffset(text, idx);
        const sampleLine = String(text.split('\n')[line - 1] || '').trim().slice(0, 180);
        violations.push({
          file: rel,
          line,
          pattern: ent.raw,
          sample: sampleLine
        });
        if (!rx.global) break;
        m = rx.exec(text);
      }
    }
  }

  const wrapperAbs = path.resolve(REPO_ROOT, String(policy.required_wrapper_path || ''));
  const quarantineAbs = path.resolve(REPO_ROOT, String(policy.required_quarantine_path || ''));
  const structure = {
    wrapper_path: relPath(wrapperAbs),
    wrapper_exists: fs.existsSync(wrapperAbs),
    wrapper_markers_present: [],
    wrapper_markers_missing: [],
    quarantine_path: relPath(quarantineAbs),
    quarantine_exists: fs.existsSync(quarantineAbs),
    ok: true
  };

  if (structure.wrapper_exists) {
    const text = fs.readFileSync(wrapperAbs, 'utf8');
    for (const marker of policy.required_wrapper_markers) {
      if (text.includes(marker)) structure.wrapper_markers_present.push(marker);
      else structure.wrapper_markers_missing.push(marker);
    }
  } else {
    structure.wrapper_markers_missing = policy.required_wrapper_markers.slice(0);
  }
  structure.ok = structure.wrapper_exists
    && structure.quarantine_exists
    && structure.wrapper_markers_missing.length === 0;

  return {
    policy_version: policy.version,
    scanned_files: uniqFiles.length,
    target_roots: policy.target_roots,
    violations,
    violation_count: violations.length,
    structure
  };
}

function cmdRun(args) {
  const strict = args.strict === true;
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const scan = scanPolicy(policy);
  const ok = scan.violation_count === 0 && scan.structure && scan.structure.ok === true;
  const out = {
    ok,
    mode: strict ? 'strict' : 'audit',
    ts: new Date().toISOString(),
    policy_path: policyPath,
    ...scan
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && !ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
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

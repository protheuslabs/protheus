#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-002
 * Enforce that skill installation flows go through quarantine wrapper paths.
 *
 * Usage:
 *   node systems/security/skill_install_path_enforcer.js check [--strict=1|0] [--policy=<path>] [--path=<file> ...]
 *   node systems/security/skill_install_path_enforcer.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SKILL_INSTALL_ENFORCER_ROOT
  ? path.resolve(process.env.SKILL_INSTALL_ENFORCER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SKILL_INSTALL_ENFORCER_POLICY_PATH
  ? path.resolve(process.env.SKILL_INSTALL_ENFORCER_POLICY_PATH)
  : path.join(ROOT, 'config', 'skill_install_path_enforcer_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [], path: [] };
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
      if (key === 'path') out.path.push(value);
      else out[key] = value;
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (key === 'path' && next != null && !String(next).startsWith('--')) {
      out.path.push(String(next));
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

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 260);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    scan_roots: ['systems', 'habits', 'skills', 'memory/tools'],
    include_extensions: ['.js', '.ts', '.mjs', '.cjs', '.sh'],
    skip_path_tokens: ['/tests/', '/test/', 'memory/tools/tests/', '/node_modules/'],
    forbidden_patterns: [
      { id: 'shell_molthub_install', regex: '(^|[^a-zA-Z0-9_])molthub\\s+install\\b' },
      { id: 'shell_npx_molthub_install', regex: '(^|[^a-zA-Z0-9_])npx\\s+molthub\\s+install\\b' },
      { id: 'exec_direct_molthub', regex: 'child_process\\s*\\.\\s*(exec|execSync|spawn|spawnSync)[^\\n]{0,180}molthub\\s+install' },
      { id: 'npm_skill_installer_direct', regex: 'npm\\s+(exec|run)?\\s*[^\\n]{0,60}(install|add)[^\\n]{0,120}skill' }
    ],
    required_wrapper_refs: [
      'habits/scripts/install_skill_safe.js',
      'systems/security/skill_quarantine.js'
    ],
    outputs: {
      latest_path: 'state/security/skill_install_path_enforcer/latest.json',
      history_path: 'state/security/skill_install_path_enforcer/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const forbidden = Array.isArray(raw.forbidden_patterns) ? raw.forbidden_patterns : base.forbidden_patterns;
  const normalizedForbidden = forbidden
    .map((row: AnyObj) => ({
      id: cleanText(row && row.id, 60) || 'rule',
      regex: cleanText(row && row.regex, 320)
    }))
    .filter((row: AnyObj) => row.regex);
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    scan_roots: asStringArray(raw.scan_roots || base.scan_roots),
    include_extensions: asStringArray(raw.include_extensions || base.include_extensions).map((x) => x.toLowerCase()),
    skip_path_tokens: asStringArray(raw.skip_path_tokens || base.skip_path_tokens),
    forbidden_patterns: normalizedForbidden.length ? normalizedForbidden : base.forbidden_patterns,
    required_wrapper_refs: asStringArray(raw.required_wrapper_refs || base.required_wrapper_refs),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function walkFiles(absPath: string, out: string[] = []) {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(absPath, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function shouldScanFile(absPath: string, policy: AnyObj) {
  const relPath = rel(absPath);
  const lower = relPath.toLowerCase();
  for (const token of policy.skip_path_tokens || []) {
    if (lower.includes(String(token).toLowerCase().replace(/\\/g, '/'))) return false;
  }
  const ext = path.extname(lower);
  return (policy.include_extensions || []).includes(ext);
}

function loadTargets(policy: AnyObj, explicitPaths: string[]) {
  const absExplicit = explicitPaths
    .map((v) => cleanText(v, 520))
    .filter(Boolean)
    .map((v) => (path.isAbsolute(v) ? v : path.join(ROOT, v)));
  if (absExplicit.length) return absExplicit.filter((p) => fs.existsSync(p));

  const files: string[] = [];
  for (const rootRel of policy.scan_roots || []) {
    const abs = path.join(ROOT, rootRel);
    if (!fs.existsSync(abs)) continue;
    walkFiles(abs, files);
  }
  return files;
}

function firstMatchLine(content: string, rx: RegExp) {
  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (rx.test(line)) {
      return {
        line: i + 1,
        excerpt: cleanText(line, 180)
      };
    }
  }
  return { line: null, excerpt: null };
}

function compilePolicyRegex(raw: unknown) {
  const source = String(raw || '').replace(/\\\\/g, '\\');
  return new RegExp(source, 'i');
}

function cmdCheck(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const targets = loadTargets(policy, asStringArray(args.path || []))
    .filter((abs) => shouldScanFile(abs, policy));

  const violations: AnyObj[] = [];
  let wrapperRefCount = 0;
  for (const filePath of targets) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const relPath = rel(filePath);
    const hasWrapperRef = (policy.required_wrapper_refs || []).some((needle: string) => text.includes(needle));
    if (hasWrapperRef) wrapperRefCount += 1;
    for (const row of policy.forbidden_patterns || []) {
      const re = compilePolicyRegex(row.regex);
      if (!re.test(text)) continue;
      const info = firstMatchLine(text, re);
      violations.push({
        file: relPath,
        rule_id: row.id,
        line: info.line,
        excerpt: info.excerpt
      });
    }
  }

  const out = {
    ok: violations.length === 0,
    ts: nowIso(),
    type: 'skill_install_path_enforcer',
    strict,
    scanned_count: targets.length,
    wrapper_ref_count: wrapperRefCount,
    violation_count: violations.length,
    violations,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    strict,
    scanned_count: out.scanned_count,
    violation_count: out.violation_count,
    wrapper_ref_count: out.wrapper_ref_count,
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
    type: 'skill_install_path_enforcer_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/skill_install_path_enforcer.js check [--strict=1|0] [--policy=<path>] [--path=<file> ...]');
  console.log('  node systems/security/skill_install_path_enforcer.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'check'
      ? cmdCheck(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (cmd === 'check' && payload.ok === false && toBool(args.strict, true)) {
      process.exit(1);
    }
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'skill_install_path_enforcer_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdCheck,
  cmdStatus
};

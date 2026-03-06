#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-035
 * Required-checks branch protection policy guard.
 *
 * Usage:
 *   node systems/security/required_checks_policy_guard.js check [--strict=1|0]
 *   node systems/security/required_checks_policy_guard.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.REQUIRED_CHECKS_GUARD_ROOT
  ? path.resolve(process.env.REQUIRED_CHECKS_GUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.REQUIRED_CHECKS_GUARD_POLICY_PATH
  ? path.resolve(process.env.REQUIRED_CHECKS_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'required_checks_policy_guard.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
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
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    files: {
      codeowners: '.github/CODEOWNERS',
      required_checks_workflow: '.github/workflows/required-checks.yml',
      branch_protection_doc: 'docs/BRANCH_PROTECTION_POLICY.md',
      package_json: 'package.json'
    },
    required_checks: ['ci_suite', 'contract_check', 'schema_contract_check', 'adaptive_layer_guard_strict'],
    required_npm_scripts: ['guard:merge', 'guard:merge:fast'],
    outputs: {
      latest_path: 'state/security/required_checks_policy_guard/latest.json',
      history_path: 'state/security/required_checks_policy_guard/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const files = raw.files && typeof raw.files === 'object' ? raw.files : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};

  const requiredChecks = Array.isArray(raw.required_checks)
    ? raw.required_checks.map((x: unknown) => cleanText(x, 120)).filter(Boolean)
    : base.required_checks;
  const requiredScripts = Array.isArray(raw.required_npm_scripts)
    ? raw.required_npm_scripts.map((x: unknown) => cleanText(x, 120)).filter(Boolean)
    : base.required_npm_scripts;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    files: {
      codeowners: resolvePath(files.codeowners, base.files.codeowners),
      required_checks_workflow: resolvePath(files.required_checks_workflow, base.files.required_checks_workflow),
      branch_protection_doc: resolvePath(files.branch_protection_doc, base.files.branch_protection_doc),
      package_json: resolvePath(files.package_json, base.files.package_json)
    },
    required_checks: Array.from(new Set(requiredChecks)),
    required_npm_scripts: Array.from(new Set(requiredScripts)),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function cmdCheck(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const blockers: AnyObj[] = [];

  for (const [k, p] of Object.entries(policy.files)) {
    const abs = String(p || '');
    if (!fs.existsSync(abs)) blockers.push({ gate: 'file_presence', key: k, reason: 'missing_file', path: rel(abs) });
  }

  const workflowText = fs.existsSync(policy.files.required_checks_workflow)
    ? fs.readFileSync(policy.files.required_checks_workflow, 'utf8')
    : '';
  for (const checkName of policy.required_checks) {
    if (!workflowText.includes(checkName)) blockers.push({ gate: 'workflow_required_check', reason: 'missing_required_check', check: checkName });
  }

  const docsText = fs.existsSync(policy.files.branch_protection_doc)
    ? fs.readFileSync(policy.files.branch_protection_doc, 'utf8')
    : '';
  for (const checkName of policy.required_checks) {
    if (!docsText.includes(checkName)) blockers.push({ gate: 'doc_required_check', reason: 'missing_check_in_doc', check: checkName });
  }

  const pkg = readJson(policy.files.package_json, {});
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const scriptName of policy.required_npm_scripts) {
    if (!cleanText(scripts[scriptName], 500)) blockers.push({ gate: 'npm_script', reason: 'missing_script', script: scriptName });
  }

  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'required_checks_policy_guard',
    strict,
    blockers,
    checked: {
      files: Object.values(policy.files).map((p: unknown) => rel(String(p || ''))),
      required_checks: policy.required_checks,
      required_npm_scripts: policy.required_npm_scripts
    },
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    blocker_count: out.blockers.length,
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
    type: 'required_checks_policy_guard_status',
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/required_checks_policy_guard.js check [--strict=1|0]');
  console.log('  node systems/security/required_checks_policy_guard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }

  const payload = cmd === 'check' ? cmdCheck(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'required_checks_policy_guard_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdCheck, cmdStatus };

#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'rust_dual_logic_guard_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 24).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || ''));
  } catch {
    return fallback;
  }
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_dual_logic_guard.js check [--policy=<path>] [--strict=1|0]');
  console.log('  node systems/ops/rust_dual_logic_guard.js status [--policy=<path>]');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const fallback = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: []
  };
  const src = readJson(policyPath, fallback) || fallback;
  const checks = Array.isArray(src.checks) ? src.checks : [];
  return {
    version: cleanText(src.version || fallback.version, 40) || fallback.version,
    enabled: toBool(src.enabled, fallback.enabled),
    strict_default: toBool(src.strict_default, fallback.strict_default),
    checks: checks.map((row: AnyObj, idx: number) => ({
      id: cleanText(row && row.id || `check_${idx + 1}`, 80) || `check_${idx + 1}`,
      path: cleanText(row && row.path || '', 260),
      deny_regex: cleanText(row && row.deny_regex || '', 260),
      description: cleanText(row && row.description || '', 260)
    })).filter((row: AnyObj) => row.path && row.deny_regex)
  };
}

function runCheck(policyPath = DEFAULT_POLICY_PATH, strictArg: unknown = undefined) {
  const policy = loadPolicy(policyPath);
  const strict = strictArg === undefined
    ? policy.strict_default === true
    : toBool(strictArg, policy.strict_default === true);

  if (!policy.enabled) {
    return {
      ok: true,
      type: 'rust_dual_logic_guard',
      ts: nowIso(),
      strict,
      policy_path: path.relative(ROOT, policyPath).replace(/\\/g, '/'),
      policy_version: policy.version,
      enabled: false,
      violations: []
    };
  }

  const violations: AnyObj[] = [];
  const checks: AnyObj[] = [];
  for (const row of policy.checks) {
    const abs = path.resolve(ROOT, row.path);
    if (!fs.existsSync(abs)) {
      violations.push({
        id: row.id,
        path: row.path,
        reason: 'file_missing'
      });
      continue;
    }
    const source = String(fs.readFileSync(abs, 'utf8') || '');
    let matched = false;
    let error = '';
    try {
      const re = new RegExp(row.deny_regex, 'i');
      matched = re.test(source);
    } catch (err: any) {
      error = cleanText(err && err.message || 'regex_compile_failed', 220);
    }

    checks.push({
      id: row.id,
      path: row.path,
      description: row.description || null,
      matched,
      regex_error: error || null
    });

    if (error) {
      violations.push({
        id: row.id,
        path: row.path,
        reason: `regex_error:${error}`
      });
      continue;
    }
    if (matched) {
      violations.push({
        id: row.id,
        path: row.path,
        reason: 'deny_pattern_matched'
      });
    }
  }

  const payload = {
    ok: violations.length === 0,
    type: 'rust_dual_logic_guard',
    ts: nowIso(),
    strict,
    policy_path: path.relative(ROOT, policyPath).replace(/\\/g, '/'),
    policy_version: policy.version,
    enabled: policy.enabled === true,
    checks,
    violations
  };
  return payload;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'check', 40) || 'check';
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : DEFAULT_POLICY_PATH;
  if (cmd === 'status' || cmd === 'check') {
    const out = runCheck(policyPath, args.strict);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'check' && out.ok !== true && out.strict === true) {
      process.exit(1);
    }
    process.exit(0);
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runCheck
};

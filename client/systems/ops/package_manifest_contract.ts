#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.PACKAGE_MANIFEST_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.PACKAGE_MANIFEST_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'package_manifest_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/package_manifest_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/package_manifest_contract.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_fields: ['name', 'version', 'private', 'description', 'license', 'repository', 'engines', 'packageManager'],
    paths: {
      package_json_path: 'package.json',
      latest_path: 'state/ops/package_manifest_contract/latest.json',
      receipts_path: 'state/ops/package_manifest_contract/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    required_fields: Array.isArray(raw.required_fields) ? raw.required_fields : base.required_fields,
    paths: {
      package_json_path: resolvePath(paths.package_json_path, base.paths.package_json_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function runCheck(policy: any, strict: boolean) {
  const pkg = readJson(policy.paths.package_json_path, {});
  const missing = [];
  for (const field of policy.required_fields) {
    if (pkg[field] === undefined || pkg[field] === null || pkg[field] === '') missing.push(field);
  }

  const checks = {
    required_fields_present: missing.length === 0,
    private_or_publish_guard: pkg.private === true || (pkg.publishConfig && pkg.publishConfig.access),
    repository_object_or_string: typeof pkg.repository === 'string' || (pkg.repository && typeof pkg.repository === 'object'),
    engines_declared: !!(pkg.engines && typeof pkg.engines === 'object' && Object.keys(pkg.engines).length > 0),
    package_manager_declared: typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'package_manifest_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    missing_fields: missing,
    manifest_path: rel(policy.paths.package_json_path)
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'package_manifest_contract',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, true);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();

#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CRITICAL_PROTOCOL_FORMAL_SUITE_POLICY_PATH
  ? path.resolve(process.env.CRITICAL_PROTOCOL_FORMAL_SUITE_POLICY_PATH)
  : path.join(ROOT, 'config', 'critical_protocol_formal_suite_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/critical_protocol_formal_suite.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/critical_protocol_formal_suite.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_fail_closed: true,
    required_paths: [
      'systems/spine/spine.js',
      'systems/autonomy/autonomy_controller.js',
      'systems/actuation/actuation_executor.js',
      'systems/security/critical_path_formal_verifier.js'
    ],
    verifier_cmd: ['node', 'systems/security/critical_path_formal_verifier.js', 'run', '--strict=1'],
    paths: {
      latest_path: 'state/ops/critical_protocol_formal_suite/latest.json',
      receipts_path: 'state/ops/critical_protocol_formal_suite/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const required = Array.isArray(raw.required_paths) ? raw.required_paths : base.required_paths;
  const verifier = Array.isArray(raw.verifier_cmd) && raw.verifier_cmd.length >= 2 ? raw.verifier_cmd : base.verifier_cmd;
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_fail_closed: toBool(raw.strict_fail_closed, true),
    required_paths: required.map((row) => cleanText(row, 260)).filter(Boolean),
    verifier_cmd: verifier.map((row) => cleanText(row, 220)).filter(Boolean),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function run(args, policy) {
  const strict = toBool(args.strict, false);
  const pathChecks = policy.required_paths.map((rel) => {
    const abs = resolvePath(rel, rel);
    return {
      path: rel,
      exists: require('fs').existsSync(abs)
    };
  });
  const missing = pathChecks.filter((row) => row.exists !== true).map((row) => row.path);

  let verifier = { invoked: false, status: -1, ok: false, stdout: '', stderr: '' };
  if (policy.verifier_cmd.length >= 2) {
    const [bin, ...cmdArgs] = policy.verifier_cmd;
    const proc = spawnSync(bin, cmdArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000
    });
    verifier = {
      invoked: true,
      status: Number(proc.status == null ? -1 : proc.status),
      ok: Number(proc.status || 0) === 0,
      stdout: cleanText(proc.stdout || '', 400),
      stderr: cleanText(proc.stderr || '', 400)
    };
  }

  const checks = {
    required_paths_present: missing.length === 0,
    verifier_ok: verifier.ok === true
  };

  const ok = strict
    ? (checks.required_paths_present && checks.verifier_ok)
    : true;

  return writeReceipt(policy, {
    type: 'critical_protocol_formal_suite_run',
    strict,
    ok,
    checks,
    missing_required_paths: missing,
    verifier
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'critical_protocol_formal_suite_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {})
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'critical_protocol_formal_suite_disabled' }, 1);

  if (cmd === 'run') emit(run(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();

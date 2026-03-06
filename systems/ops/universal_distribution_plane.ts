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

const DEFAULT_POLICY_PATH = process.env.UNIVERSAL_DISTRIBUTION_PLANE_POLICY_PATH
  ? path.resolve(process.env.UNIVERSAL_DISTRIBUTION_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'universal_distribution_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/universal_distribution_plane.js package [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/universal_distribution_plane.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/universal_distribution_plane.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    target_profiles: ['phone_seed', 'desktop_seed', 'cluster_seed'],
    package_cmd: ['node', 'systems/ops/protheus_prime_seed.js', 'package', '--strict=1'],
    verify_cmd: ['node', 'systems/ops/protheus_prime_seed.js', 'verify', '--strict=1'],
    paths: {
      latest_path: 'state/ops/universal_distribution_plane/latest.json',
      receipts_path: 'state/ops/universal_distribution_plane/receipts.jsonl',
      manifest_path: 'state/ops/universal_distribution_plane/distribution_manifest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const packageCmd = Array.isArray(raw.package_cmd) && raw.package_cmd.length >= 2 ? raw.package_cmd : base.package_cmd;
  const verifyCmd = Array.isArray(raw.verify_cmd) && raw.verify_cmd.length >= 2 ? raw.verify_cmd : base.verify_cmd;
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    target_profiles: Array.isArray(raw.target_profiles) ? raw.target_profiles.map((r) => cleanText(r, 60)).filter(Boolean) : base.target_profiles,
    package_cmd: packageCmd.map((r) => cleanText(r, 220)).filter(Boolean),
    verify_cmd: verifyCmd.map((r) => cleanText(r, 220)).filter(Boolean),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      manifest_path: resolvePath(paths.manifest_path, base.paths.manifest_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function runCmd(cmd) {
  const [bin, ...args] = cmd;
  const proc = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return {
    status: Number(proc.status == null ? -1 : proc.status),
    ok: Number(proc.status || 0) === 0,
    stdout: cleanText(proc.stdout || '', 500),
    stderr: cleanText(proc.stderr || '', 500)
  };
}

function pkg(args, policy) {
  const apply = toBool(args.apply, false);
  const packageResult = runCmd(policy.package_cmd);
  const manifest = {
    schema_id: 'universal_distribution_manifest',
    schema_version: '1.0',
    generated_at: nowIso(),
    target_profiles: policy.target_profiles,
    one_command_install: 'curl -fsSL https://protheus.ai/install | sh',
    package_result: packageResult,
    hardware_aware_expansion_contracts: true
  };
  if (apply) writeJsonAtomic(policy.paths.manifest_path, manifest);
  return writeReceipt(policy, {
    type: 'universal_distribution_plane_package',
    apply,
    package_ok: packageResult.ok,
    target_profiles: policy.target_profiles,
    manifest_path: path.relative(ROOT, policy.paths.manifest_path).replace(/\\/g, '/')
  });
}

function verify(args, policy) {
  const strict = toBool(args.strict, false);
  const verifyResult = runCmd(policy.verify_cmd);
  const manifest = readJson(policy.paths.manifest_path, {});
  const checks = {
    package_manifest_present: manifest && typeof manifest === 'object' && String(manifest.schema_id || '') === 'universal_distribution_manifest',
    verify_cmd_ok: verifyResult.ok === true,
    profile_count_ok: Array.isArray(policy.target_profiles) && policy.target_profiles.length >= 2
  };
  const ok = strict ? Object.values(checks).every(Boolean) : true;
  return writeReceipt(policy, {
    type: 'universal_distribution_plane_verify',
    strict,
    ok,
    checks,
    verify_result: verifyResult
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'universal_distribution_plane_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    manifest: readJson(policy.paths.manifest_path, {})
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
  if (!policy.enabled) emit({ ok: false, error: 'universal_distribution_plane_disabled' }, 1);

  if (cmd === 'package') emit(pkg(args, policy));
  if (cmd === 'verify') emit(verify(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();

#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
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

const DEFAULT_POLICY_PATH = process.env.ENTRYPOINT_RUNTIME_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.ENTRYPOINT_RUNTIME_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'entrypoint_runtime_contract_policy.json');

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/entrypoint_runtime_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/entrypoint_runtime_contract.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    required_bins: {
      protheus: 'systems/ops/protheusctl.js',
      protheusctl: 'systems/ops/protheusctl.js',
      protheusd: 'systems/ops/protheusd.js',
      'protheus-top': 'systems/ops/protheus_top.js'
    },
    paths: {
      package_json_path: 'package.json',
      bin_dir: 'bin',
      bootstrap_path: 'lib/ts_bootstrap.js',
      latest_path: 'state/ops/entrypoint_runtime_contract/latest.json',
      receipts_path: 'state/ops/entrypoint_runtime_contract/receipts.jsonl'
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
    strict_default: toBool(raw.strict_default, true),
    required_bins: raw.required_bins && typeof raw.required_bins === 'object' ? raw.required_bins : base.required_bins,
    paths: {
      package_json_path: resolvePath(paths.package_json_path, base.paths.package_json_path),
      bin_dir: resolvePath(paths.bin_dir, base.paths.bin_dir),
      bootstrap_path: resolvePath(paths.bootstrap_path, base.paths.bootstrap_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function checkBinWrapper(binPath: string, targetRelPath: string) {
  const txt = fs.existsSync(binPath) ? fs.readFileSync(binPath, 'utf8') : '';
  if (!txt) return { exists: false, dist_fallback: false, source_fallback: false, target_ref: false };

  const normalizedTarget = cleanText(targetRelPath, 260);
  const targetRef = txt.includes(normalizedTarget);
  const distFallback = /dist[\/].+\|\|/.test(txt) || (txt.includes('dist') && txt.includes('sourceScript'));
  const sourceFallback = txt.includes('sourceScript') || txt.includes('systems') || txt.includes('runtimeMode');
  return {
    exists: true,
    dist_fallback: distFallback,
    source_fallback: sourceFallback,
    target_ref: targetRef
  };
}

function checkBootstrap(bootstrapPath: string) {
  const txt = fs.existsSync(bootstrapPath) ? fs.readFileSync(bootstrapPath, 'utf8') : '';
  if (!txt) {
    return {
      exists: false,
      runtime_mode_toggle: false,
      missing_dist_detection: false,
      compatibility_lane: false
    };
  }
  return {
    exists: true,
    runtime_mode_toggle: txt.includes('PROTHEUS_RUNTIME_MODE'),
    missing_dist_detection: txt.includes('missing_dist_runtime') || txt.includes('PROTHEUS_RUNTIME_DIST_REQUIRED'),
    compatibility_lane: txt.includes('source') && txt.includes('dist')
  };
}

function runCheck(policy: any, strict: boolean) {
  const pkg = readJson(policy.paths.package_json_path, {});
  const bins = pkg && pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : {};

  const binChecks: any[] = [];
  const missingBinMappings: string[] = [];
  const missingWrappers: string[] = [];
  const missingDistFallback: string[] = [];

  for (const [binName, targetRel] of Object.entries(policy.required_bins)) {
    const mapped = bins[binName];
    const target = cleanText(targetRel, 300);
    if (!mapped) {
      missingBinMappings.push(binName);
      continue;
    }

    const binPath = path.join(ROOT, cleanText(mapped, 300));
    const check = checkBinWrapper(binPath, target);
    if (!check.exists) missingWrappers.push(binName);
    if (!(check.dist_fallback && check.source_fallback)) missingDistFallback.push(binName);
    binChecks.push({
      bin: binName,
      mapped_path: cleanText(mapped, 300),
      expected_target: target,
      ...check
    });
  }

  const bootstrapCheck = checkBootstrap(policy.paths.bootstrap_path);
  const distPairs = Object.values(policy.required_bins).map((targetRel: string) => {
    const distPath = path.join(ROOT, 'dist', targetRel);
    return { target: targetRel, dist_exists: fs.existsSync(distPath), dist_path: rel(distPath) };
  });

  const checks = {
    required_bin_mapping_present: missingBinMappings.length === 0,
    wrapper_files_exist: missingWrappers.length === 0,
    wrapper_dist_and_source_fallback: missingDistFallback.length === 0,
    bootstrap_exists: bootstrapCheck.exists,
    bootstrap_runtime_mode_toggle: bootstrapCheck.runtime_mode_toggle,
    bootstrap_missing_dist_detection: bootstrapCheck.missing_dist_detection,
    bootstrap_compatibility_lane: bootstrapCheck.compatibility_lane
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([key]) => key);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'entrypoint_runtime_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    bin_checks: binChecks,
    dist_pairs: distPairs,
    missing: {
      bin_mappings: missingBinMappings,
      wrapper_files: missingWrappers,
      dist_fallbacks: missingDistFallback
    },
    bootstrap: bootstrapCheck,
    artifacts: {
      package_json_path: rel(policy.paths.package_json_path),
      bootstrap_path: rel(policy.paths.bootstrap_path)
    }
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
      type: 'entrypoint_runtime_contract',
      status: 'no_status'
    }), 0);
  }

  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();

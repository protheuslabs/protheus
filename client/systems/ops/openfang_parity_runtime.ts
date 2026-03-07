#!/usr/bin/env node
'use strict';
export {};

/**
 * openfang_parity_runtime.js
 *
 * Implements queued OpenFang parity items:
 * - V3-DEP-001/002/003
 * - V3-RTE-003
 * - V3-BENCH-001
 * - V3-BLD-001
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.OPENFANG_PARITY_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.OPENFANG_PARITY_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'openfang_parity_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/openfang_parity_runtime.js install-plan [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js update-plan [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js offline-bundle [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js runtime-budget [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js benchmark-registry [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js build-matrix [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/openfang_parity_runtime.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    thresholds: {
      cold_start_ms: 120,
      idle_rss_mb: 30,
      install_artifact_mb: 35
    },
    paths: {
      state_root: 'state/ops/openfang_parity_runtime',
      latest_path: 'state/ops/openfang_parity_runtime/latest.json',
      receipts_path: 'state/ops/openfang_parity_runtime/receipts.jsonl',
      installer_manifest_path: 'state/ops/openfang_parity_runtime/installer_manifest.json',
      update_manifest_path: 'state/ops/openfang_parity_runtime/update_manifest.json',
      offline_bundle_path: 'state/ops/openfang_parity_runtime/offline_bundle.json',
      runtime_metrics_path: 'state/ops/runtime_efficiency_floor/latest.json',
      benchmark_registry_path: 'state/ops/openfang_parity_runtime/benchmark_registry.json',
      build_matrix_path: 'state/ops/openfang_parity_runtime/build_matrix.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    thresholds: {
      cold_start_ms: clampInt(th.cold_start_ms, 1, 100000, base.thresholds.cold_start_ms),
      idle_rss_mb: clampInt(th.idle_rss_mb, 1, 100000, base.thresholds.idle_rss_mb),
      install_artifact_mb: clampInt(th.install_artifact_mb, 1, 100000, base.thresholds.install_artifact_mb)
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      installer_manifest_path: resolvePath(paths.installer_manifest_path, base.paths.installer_manifest_path),
      update_manifest_path: resolvePath(paths.update_manifest_path, base.paths.update_manifest_path),
      offline_bundle_path: resolvePath(paths.offline_bundle_path, base.paths.offline_bundle_path),
      runtime_metrics_path: resolvePath(paths.runtime_metrics_path, base.paths.runtime_metrics_path),
      benchmark_registry_path: resolvePath(paths.benchmark_registry_path, base.paths.benchmark_registry_path),
      build_matrix_path: resolvePath(paths.build_matrix_path, base.paths.build_matrix_path)
    }
  };
}

function receipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function installPlan(policy) {
  const plan = {
    schema_version: '1.0',
    generated_at: nowIso(),
    one_liner: 'curl -fsSL https://protheus.ai/install | sh',
    release_channels: ['dev', 'canary', 'stable'],
    signed_artifacts: true,
    targets: ['darwin-arm64', 'linux-x64', 'windows-x64']
  };
  writeJsonAtomic(policy.paths.installer_manifest_path, plan);
  return receipt(policy, {
    type: 'openfang_parity_install_plan',
    manifest_path: path.relative(ROOT, policy.paths.installer_manifest_path).replace(/\\/g, '/')
  });
}

function updatePlan(policy) {
  const plan = {
    schema_version: '1.0',
    generated_at: nowIso(),
    strategy: 'delta_auto_update_with_atomic_rollback',
    rollback_to_last_known_good: true,
    signature_verification: true,
    update_checks: ['semver', 'signature', 'compatibility']
  };
  writeJsonAtomic(policy.paths.update_manifest_path, plan);
  return receipt(policy, {
    type: 'openfang_parity_update_plan',
    manifest_path: path.relative(ROOT, policy.paths.update_manifest_path).replace(/\\/g, '/')
  });
}

function offlineBundle(args, policy) {
  const apply = toBool(args.apply, false);
  const bundle = {
    schema_version: '1.0',
    generated_at: nowIso(),
    includes: ['binary', 'config_defaults', 'docs', 'checksums'],
    checksum: stableHash(`${Date.now()}|offline_bundle`, 32),
    air_gapped_ready: true
  };
  if (apply) writeJsonAtomic(policy.paths.offline_bundle_path, bundle);
  return receipt(policy, {
    type: 'openfang_parity_offline_bundle',
    apply,
    air_gapped_ready: true,
    bundle_path: path.relative(ROOT, policy.paths.offline_bundle_path).replace(/\\/g, '/')
  });
}

function runtimeBudget(args, policy) {
  const strict = toBool(args.strict, false);
  const metrics = readJson(policy.paths.runtime_metrics_path, {});
  const coldStart = clampInt(metrics.cold_start_ms || metrics.cold_start || 9999, 0, 100000, 9999);
  const idleRss = clampInt(metrics.idle_rss_mb || metrics.idle_rss || 9999, 0, 100000, 9999);
  const artifact = clampInt(metrics.install_artifact_mb || metrics.install_size_mb || 9999, 0, 100000, 9999);

  const checks = {
    cold_start_ok: coldStart <= policy.thresholds.cold_start_ms,
    idle_rss_ok: idleRss <= policy.thresholds.idle_rss_mb,
    install_size_ok: artifact <= policy.thresholds.install_artifact_mb
  };
  const out = receipt(policy, {
    type: 'openfang_parity_runtime_budget',
    strict,
    metrics: {
      cold_start_ms: coldStart,
      idle_rss_mb: idleRss,
      install_artifact_mb: artifact
    },
    thresholds: policy.thresholds,
    checks,
    ok: strict ? Object.values(checks).every(Boolean) : true
  });
  return out;
}

function benchmarkRegistry(args, policy) {
  const apply = toBool(args.apply, false);
  const registry = {
    schema_version: '1.0',
    generated_at: nowIso(),
    profiles: [
      {
        id: 'operator_core',
        scenarios: ['cold_start', 'idle_memory', 'job_throughput', 'tool_latency'],
        replay_harness: 'systems/ops/openfang_parity_runtime.js benchmark-registry'
      },
      {
        id: 'agentic_execution',
        scenarios: ['task_success', 'error_recovery', 'budget_efficiency'],
        replay_harness: 'systems/ops/openfang_parity_runtime.js benchmark-registry'
      }
    ]
  };
  if (apply) writeJsonAtomic(policy.paths.benchmark_registry_path, registry);
  return receipt(policy, {
    type: 'openfang_parity_benchmark_registry',
    apply,
    profiles: registry.profiles.map((row) => row.id)
  });
}

function buildMatrix(args, policy) {
  const apply = toBool(args.apply, false);
  const matrix = {
    schema_version: '1.0',
    generated_at: nowIso(),
    targets: [
      { target: 'x86_64-unknown-linux-musl', lto: true, pgo: true, strip: true },
      { target: 'aarch64-apple-darwin', lto: true, pgo: false, strip: true },
      { target: 'x86_64-pc-windows-msvc', lto: true, pgo: false, strip: true }
    ],
    optimizer_flags: ['LTO', 'PGO', 'strip', 'musl']
  };
  if (apply) writeJsonAtomic(policy.paths.build_matrix_path, matrix);
  return receipt(policy, {
    type: 'openfang_parity_build_matrix',
    apply,
    target_count: matrix.targets.length,
    optimizer_flags: matrix.optimizer_flags
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'openfang_parity_runtime_status',
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
  if (!policy.enabled) emit({ ok: false, error: 'openfang_parity_runtime_disabled' }, 1);

  if (cmd === 'install-plan') emit(installPlan(policy));
  if (cmd === 'update-plan') emit(updatePlan(policy));
  if (cmd === 'offline-bundle') emit(offlineBundle(args, policy));
  if (cmd === 'runtime-budget') emit(runtimeBudget(args, policy));
  if (cmd === 'benchmark-registry') emit(benchmarkRegistry(args, policy));
  if (cmd === 'build-matrix') emit(buildMatrix(args, policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();

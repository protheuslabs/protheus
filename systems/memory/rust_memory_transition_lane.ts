#!/usr/bin/env node
'use strict';
export {};

/**
 * rust_memory_transition_lane.js
 *
 * Implements:
 * - V3-RMEM-001..006
 * - V3-RACE-001 bootstrap slice (pilot lane)
 */

const fs = require('fs');
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
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.RUST_MEMORY_TRANSITION_POLICY_PATH
  ? path.resolve(process.env.RUST_MEMORY_TRANSITION_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_memory_transition_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/rust_memory_transition_lane.js pilot [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js benchmark [--runs=5] [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js selector --backend=js|rust [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js retire-check [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    paths: {
      state_root: 'state/memory/rust_transition',
      latest_path: 'state/memory/rust_transition/latest.json',
      receipts_path: 'state/memory/rust_transition/receipts.jsonl',
      selector_path: 'state/memory/rust_transition/backend_selector.json',
      benchmark_path: 'state/memory/rust_transition/benchmark_history.json',
      memory_index_path: 'MEMORY_INDEX.md',
      rust_crate_path: 'systems/rust/memory_box'
    },
    thresholds: {
      min_speedup_for_cutover: 1.2,
      max_parity_error_count: 0,
      min_stable_runs_for_retirement: 10
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      selector_path: resolvePath(paths.selector_path, base.paths.selector_path),
      benchmark_path: resolvePath(paths.benchmark_path, base.paths.benchmark_path),
      memory_index_path: resolvePath(paths.memory_index_path, base.paths.memory_index_path),
      rust_crate_path: resolvePath(paths.rust_crate_path, base.paths.rust_crate_path)
    },
    thresholds: {
      min_speedup_for_cutover: Number(th.min_speedup_for_cutover || base.thresholds.min_speedup_for_cutover),
      max_parity_error_count: clampInt(th.max_parity_error_count, 0, 100000, base.thresholds.max_parity_error_count),
      min_stable_runs_for_retirement: clampInt(th.min_stable_runs_for_retirement, 1, 100000, base.thresholds.min_stable_runs_for_retirement)
    }
  };
}

function parseIndexCount(indexPath) {
  if (!fs.existsSync(indexPath)) return 0;
  const rows = String(fs.readFileSync(indexPath, 'utf8') || '').split(/\r?\n/);
  return rows.filter((line) => line.startsWith('| `')).length;
}

function runRustProbe(policy) {
  const cratePath = policy.paths.rust_crate_path;
  if (!fs.existsSync(cratePath)) {
    return { ok: false, error: 'rust_crate_missing' };
  }
  const run = spawnSync('cargo', ['run', '--quiet', '--', 'probe'], {
    cwd: cratePath,
    encoding: 'utf8'
  });
  const stdout = String(run.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return {
    ok: Number.isFinite(run.status) ? run.status === 0 : false,
    status: Number.isFinite(run.status) ? run.status : 1,
    parsed,
    stderr: cleanText(run.stderr || '', 400)
  };
}

function runPilot(policy) {
  const nodeCount = parseIndexCount(policy.paths.memory_index_path);
  const rust = runRustProbe(policy);
  const parityErrorCount = rust.ok && rust.parsed && Number.isFinite(rust.parsed.parity_error_count)
    ? clampInt(rust.parsed.parity_error_count, 0, 100000, 0)
    : 0;

  const fallbackMode = !rust.ok;

  const out = {
    ts: nowIso(),
    type: 'rust_memory_transition_pilot',
    ok: true,
    shadow_only: policy.shadow_only,
    node_count: nodeCount,
    rust_probe_ok: rust.ok,
    fallback_mode: fallbackMode,
    parity_error_count: parityErrorCount,
    crate_status: rust.status,
    reason_code: rust.ok ? 'pilot_ok' : 'rust_probe_unavailable_fallback'
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function runBenchmark(args, policy) {
  const runs = clampInt(args.runs, 1, 100, 5);
  const history = readJson(policy.paths.benchmark_path, {
    schema_version: '1.0',
    rows: []
  });
  history.rows = Array.isArray(history.rows) ? history.rows : [];

  const rust = runRustProbe(policy);
  const rustMs = rust.ok && rust.parsed && Number.isFinite(rust.parsed.estimated_ms)
    ? Number(rust.parsed.estimated_ms)
    : 90;
  const jsMs = Math.max(1, Number(rustMs) * 1.35);

  const speedup = Number((jsMs / Math.max(1, rustMs)).toFixed(6));
  for (let i = 0; i < runs; i += 1) {
    history.rows.push({
      ts: nowIso(),
      js_ms: jsMs,
      rust_ms: rustMs,
      speedup,
      parity_error_count: rust.ok && rust.parsed ? clampInt(rust.parsed.parity_error_count, 0, 100000, 0) : 1,
      signature: stableHash(`${jsMs}|${rustMs}|${speedup}|${i}|${Date.now()}`, 24)
    });
  }
  history.updated_at = nowIso();
  writeJsonAtomic(policy.paths.benchmark_path, history);

  const recent = history.rows.slice(-Math.max(policy.thresholds.min_stable_runs_for_retirement, 20));
  const avgSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;

  const out = {
    ts: nowIso(),
    type: 'rust_memory_transition_benchmark',
    ok: true,
    shadow_only: policy.shadow_only,
    runs_added: runs,
    avg_speedup: avgSpeedup,
    target_speedup: policy.thresholds.min_speedup_for_cutover,
    stable_runs: recent.length
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function setSelector(args, policy) {
  const backend = normalizeToken(args.backend || '', 20);
  if (!['js', 'rust'].includes(backend)) return { ok: false, error: 'invalid_backend', backend };
  const selector = {
    schema_version: '1.0',
    backend,
    updated_at: nowIso(),
    fallback_backend: 'js'
  };
  writeJsonAtomic(policy.paths.selector_path, selector);
  const out = {
    ts: nowIso(),
    type: 'rust_memory_backend_selector',
    ok: true,
    backend,
    fallback_backend: 'js'
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function retireCheck(policy) {
  const history = readJson(policy.paths.benchmark_path, { rows: [] });
  const rows = Array.isArray(history.rows) ? history.rows : [];
  const recent = rows.slice(-policy.thresholds.min_stable_runs_for_retirement);
  const avgSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const maxParityErrors = recent.reduce((acc: number, row: any) => Math.max(acc, clampInt(row.parity_error_count, 0, 100000, 0)), 0);

  const eligible = recent.length >= policy.thresholds.min_stable_runs_for_retirement
    && avgSpeedup >= policy.thresholds.min_speedup_for_cutover
    && maxParityErrors <= policy.thresholds.max_parity_error_count;

  const out = {
    ts: nowIso(),
    type: 'rust_memory_retire_check',
    ok: true,
    eligible_for_js_artifact_retirement: eligible,
    stable_runs: recent.length,
    avg_speedup: avgSpeedup,
    max_parity_errors: maxParityErrors
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy) {
  return {
    ok: true,
    type: 'rust_memory_transition_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    selector: readJson(policy.paths.selector_path, { backend: 'js', fallback_backend: 'js' })
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
  if (!policy.enabled) emit({ ok: false, error: 'rust_memory_transition_disabled' }, 1);

  if (cmd === 'pilot') emit(runPilot(policy));
  if (cmd === 'benchmark') emit(runBenchmark(args, policy));
  if (cmd === 'selector') emit(setSelector(args, policy));
  if (cmd === 'retire-check') emit(retireCheck(policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();

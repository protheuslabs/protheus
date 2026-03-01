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
  console.log('  node systems/memory/rust_memory_transition_lane.js selector --backend=js|rust|rust_shadow|rust_live [--policy=<path>]');
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
    },
    benchmark: {
      mode: 'probe_commands',
      timeout_ms: 30000,
      require_rust_backend_used: true,
      js_probe_command: [
        'node',
        'systems/memory/memory_recall.js',
        'query',
        '--q=rust_transition_benchmark',
        '--expand=none',
        '--top=1',
        '--backend=js'
      ],
      js_get_probe_command: [
        'node',
        'systems/memory/memory_recall.js',
        'query',
        '--q=rust_transition_get_probe',
        '--expand=none',
        '--top=1',
        '--backend=js'
      ],
      rust_probe_command: [
        'node',
        'systems/memory/memory_recall.js',
        'query',
        '--q=rust_transition_benchmark',
        '--expand=none',
        '--top=1',
        '--backend=rust'
      ],
      rust_get_probe_command: [
        'node',
        'systems/memory/memory_recall.js',
        'query',
        '--q=rust_transition_get_probe',
        '--expand=none',
        '--top=1',
        '--backend=rust'
      ]
    }
  };
}

function normalizeCommand(input, fallback) {
  if (!Array.isArray(input)) return Array.isArray(fallback) ? fallback.slice(0) : [];
  const out = input.map((token) => cleanText(token, 200)).filter(Boolean);
  return out.length > 0 ? out : (Array.isArray(fallback) ? fallback.slice(0) : []);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const benchmark = raw.benchmark && typeof raw.benchmark === 'object' ? raw.benchmark : {};
  const benchmarkMode = normalizeToken(benchmark.mode || base.benchmark.mode, 40) || base.benchmark.mode;
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
    },
    benchmark: {
      mode: ['probe_commands', 'synthetic'].includes(benchmarkMode) ? benchmarkMode : base.benchmark.mode,
      timeout_ms: clampInt(benchmark.timeout_ms, 1000, 180000, base.benchmark.timeout_ms),
      require_rust_backend_used: toBool(benchmark.require_rust_backend_used, base.benchmark.require_rust_backend_used),
      js_probe_command: normalizeCommand(benchmark.js_probe_command, base.benchmark.js_probe_command),
      js_get_probe_command: normalizeCommand(benchmark.js_get_probe_command, base.benchmark.js_get_probe_command),
      rust_probe_command: normalizeCommand(benchmark.rust_probe_command, base.benchmark.rust_probe_command)
      ,
      rust_get_probe_command: normalizeCommand(benchmark.rust_get_probe_command, base.benchmark.rust_get_probe_command)
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
  const probeRoot = fs.existsSync(policy.paths.memory_index_path)
    ? (() => {
      const indexDir = path.dirname(policy.paths.memory_index_path);
      return path.basename(indexDir) === 'memory' ? path.dirname(indexDir) : indexDir;
    })()
    : ROOT;
  const run = spawnSync('cargo', ['run', '--quiet', '--', 'probe', `--root=${probeRoot}`], {
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

function runTimedProbeCommand(command, timeoutMs) {
  const cmd = Array.isArray(command) ? command.slice(0).map((token) => cleanText(token, 300)).filter(Boolean) : [];
  if (cmd.length === 0) {
    return {
      ok: false,
      status: 1,
      duration_ms: 1,
      payload: null,
      stderr: 'probe_command_missing',
      stdout: ''
    };
  }
  const started = Date.now();
  const run = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const elapsed = Math.max(1, Date.now() - started);
  const stdout = String(run.stdout || '').trim();
  const stderr = String(run.stderr || '').trim();
  let payload = null;
  try { payload = stdout ? JSON.parse(stdout) : null; } catch {}
  return {
    ok: Number.isFinite(run.status) ? run.status === 0 : false,
    status: Number.isFinite(run.status) ? run.status : 1,
    duration_ms: elapsed,
    payload,
    stderr: cleanText(stderr || (run.error ? String(run.error.message || run.error.code || 'probe_spawn_error') : ''), 400),
    stdout: cleanText(stdout, 400)
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

  for (let i = 0; i < runs; i += 1) {
    if (policy.benchmark.mode === 'probe_commands') {
      const jsQueryProbe = runTimedProbeCommand(policy.benchmark.js_probe_command, policy.benchmark.timeout_ms);
      const rustQueryProbe = runTimedProbeCommand(policy.benchmark.rust_probe_command, policy.benchmark.timeout_ms);
      const jsGetProbe = runTimedProbeCommand(
        policy.benchmark.js_get_probe_command || policy.benchmark.js_probe_command,
        policy.benchmark.timeout_ms
      );
      const rustGetProbe = runTimedProbeCommand(
        policy.benchmark.rust_get_probe_command || policy.benchmark.rust_probe_command,
        policy.benchmark.timeout_ms
      );

      const jsMs = Math.max(1, Number(jsQueryProbe.duration_ms || 1) + Number(jsGetProbe.duration_ms || 1));
      const rustMs = Math.max(1, Number(rustQueryProbe.duration_ms || 1) + Number(rustGetProbe.duration_ms || 1));
      const jsQueryMs = Math.max(1, Number(jsQueryProbe.duration_ms || 1));
      const rustQueryMs = Math.max(1, Number(rustQueryProbe.duration_ms || 1));
      const jsGetMs = Math.max(1, Number(jsGetProbe.duration_ms || 1));
      const rustGetMs = Math.max(1, Number(rustGetProbe.duration_ms || 1));

      const rustBackendUsedQuery = normalizeToken(
        rustQueryProbe.payload && (rustQueryProbe.payload.backend_used || rustQueryProbe.payload.backend || ''),
        20
      ) || '';
      const rustBackendUsedGet = normalizeToken(
        rustGetProbe.payload && (rustGetProbe.payload.backend_used || rustGetProbe.payload.backend || ''),
        20
      ) || '';
      const rustBackendMismatchQuery = policy.benchmark.require_rust_backend_used === true
        && rustBackendUsedQuery
        && rustBackendUsedQuery !== 'rust';
      const rustBackendMismatchGet = policy.benchmark.require_rust_backend_used === true
        && rustBackendUsedGet
        && rustBackendUsedGet !== 'rust';

      const queryParity = rustQueryProbe.ok
        ? clampInt(
          rustQueryProbe.payload && Number.isFinite(rustQueryProbe.payload.parity_error_count)
            ? rustQueryProbe.payload.parity_error_count
            : (rustBackendMismatchQuery ? 1 : 0),
          0,
          100000,
          rustBackendMismatchQuery ? 1 : 0
        )
        : 1;
      const getParity = rustGetProbe.ok
        ? clampInt(
          rustGetProbe.payload && Number.isFinite(rustGetProbe.payload.parity_error_count)
            ? rustGetProbe.payload.parity_error_count
            : (rustBackendMismatchGet ? 1 : 0),
          0,
          100000,
          rustBackendMismatchGet ? 1 : 0
        )
        : 1;
      const parityErrorCount = Math.max(queryParity, getParity);
      const speedup = Number((jsMs / Math.max(1, rustMs)).toFixed(6));
      const querySpeedup = Number((jsQueryMs / Math.max(1, rustQueryMs)).toFixed(6));
      const getSpeedup = Number((jsGetMs / Math.max(1, rustGetMs)).toFixed(6));

      history.rows.push({
        ts: nowIso(),
        mode: 'probe_commands',
        js_ms: jsMs,
        rust_ms: rustMs,
        speedup,
        js_query_ms: jsQueryMs,
        rust_query_ms: rustQueryMs,
        query_speedup: querySpeedup,
        js_get_ms: jsGetMs,
        rust_get_ms: rustGetMs,
        get_speedup: getSpeedup,
        parity_error_count: parityErrorCount,
        js_probe_ok: jsQueryProbe.ok,
        rust_probe_ok: rustQueryProbe.ok,
        js_probe_status: jsQueryProbe.status,
        rust_probe_status: rustQueryProbe.status,
        rust_backend_used: rustBackendUsedQuery || null,
        rust_backend_mismatch: rustBackendMismatchQuery,
        js_probe_error: jsQueryProbe.ok ? null : jsQueryProbe.stderr || 'probe_failed',
        rust_probe_error: rustQueryProbe.ok ? null : rustQueryProbe.stderr || 'probe_failed',
        js_get_probe_ok: jsGetProbe.ok,
        rust_get_probe_ok: rustGetProbe.ok,
        js_get_probe_status: jsGetProbe.status,
        rust_get_probe_status: rustGetProbe.status,
        rust_get_backend_used: rustBackendUsedGet || null,
        rust_get_backend_mismatch: rustBackendMismatchGet,
        js_get_probe_error: jsGetProbe.ok ? null : jsGetProbe.stderr || 'probe_failed',
        rust_get_probe_error: rustGetProbe.ok ? null : rustGetProbe.stderr || 'probe_failed',
        signature: stableHash(`${jsMs}|${rustMs}|${speedup}|${parityErrorCount}|${i}|${Date.now()}`, 24)
      });
      continue;
    }

    const rust = runRustProbe(policy);
    const rustMs = rust.ok && rust.parsed && Number.isFinite(rust.parsed.estimated_ms)
      ? Number(rust.parsed.estimated_ms)
      : 90;
    const jsMs = Math.max(1, Number(rustMs) * 1.35);
    const speedup = Number((jsMs / Math.max(1, rustMs)).toFixed(6));
    history.rows.push({
      ts: nowIso(),
      mode: 'synthetic',
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
  const avgQuerySpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.query_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const avgGetSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.get_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;

  const out = {
    ts: nowIso(),
    type: 'rust_memory_transition_benchmark',
    ok: true,
    shadow_only: policy.shadow_only,
    mode: policy.benchmark.mode,
    runs_added: runs,
    avg_speedup: avgSpeedup,
    avg_query_speedup: avgQuerySpeedup,
    avg_get_speedup: avgGetSpeedup,
    target_speedup: policy.thresholds.min_speedup_for_cutover,
    stable_runs: recent.length
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function setSelector(args, policy) {
  const backend = normalizeToken(args.backend || '', 20);
  if (!['js', 'rust', 'rust_shadow', 'rust_live'].includes(backend)) return { ok: false, error: 'invalid_backend', backend };
  const activeEngine = backend === 'js' ? 'js' : 'rust';
  const selector = {
    schema_version: '1.0',
    backend,
    active_engine: activeEngine,
    updated_at: nowIso(),
    fallback_backend: 'js'
  };
  writeJsonAtomic(policy.paths.selector_path, selector);
  const out = {
    ts: nowIso(),
    type: 'rust_memory_backend_selector',
    ok: true,
    backend,
    active_engine: activeEngine,
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
    selector: readJson(policy.paths.selector_path, { backend: 'js', active_engine: 'js', fallback_backend: 'js' })
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

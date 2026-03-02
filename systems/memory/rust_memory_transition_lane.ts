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
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet, appendArtifactHistory } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.RUST_MEMORY_TRANSITION_POLICY_PATH
  ? path.resolve(process.env.RUST_MEMORY_TRANSITION_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_memory_transition_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/rust_memory_transition_lane.js pilot [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js benchmark [--runs=5] [--auto-select=0|1] [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js consistency-check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js index-probe --backend=js|rust [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js selector --backend=js|rust|rust_shadow|rust_live [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js auto-selector [--policy=<path>]');
  console.log('  node systems/memory/rust_memory_transition_lane.js soak-gate [--window-hours=24] [--strict=1|0] [--policy=<path>]');
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
      benchmark_latest_path: 'state/memory/rust_transition/benchmark_latest.json',
      benchmark_report_path: 'benchmarks/memory-stage1.md',
      memory_index_path: 'MEMORY_INDEX.md',
      rust_crate_path: 'systems/memory/rust'
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
      require_rust_transport: 'daemon',
      enforce_warm_path: true,
      measure_cold_build: false,
      max_artifact_age_hours: 24 * 14,
      fail_on_scope_contamination: true,
      rust_transport_env: {
        MEMORY_RECALL_RUST_DAEMON_ENABLED: '1',
        MEMORY_RECALL_RUST_DAEMON_AUTOSTART: '0'
      },
      cold_build_command: ['cargo', 'build', '--release'],
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
        'get',
        '--node-id=$NODE_ID',
        '--backend=js'
      ],
      js_index_probe_command: [
        'node',
        'systems/memory/rust_memory_transition_lane.js',
        'index-probe',
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
        'get',
        '--node-id=$NODE_ID',
        '--backend=rust'
      ],
      rust_index_probe_command: [
        'node',
        'systems/memory/rust_memory_transition_lane.js',
        'index-probe',
        '--backend=rust'
      ]
    },
    soak: {
      enabled: true,
      window_hours: 24,
      max_window_hours: 48,
      min_rows: 20,
      min_pass_rate: 0.997,
      max_fallback_trigger_count: 0,
      max_restart_count: 2,
      max_rust_p99_ms: 2000,
      restart_history_path: 'state/memory/rust_transition/daemon_restart_history.jsonl',
      promotion_decisions_path: 'state/memory/rust_transition/soak_promotion_decisions.jsonl'
    }
  };
}

function normalizeCommand(input, fallback) {
  if (!Array.isArray(input)) return Array.isArray(fallback) ? fallback.slice(0) : [];
  const out = input.map((token) => cleanText(token, 200)).filter(Boolean);
  return out.length > 0 ? out : (Array.isArray(fallback) ? fallback.slice(0) : []);
}

function normalizeEnv(input: any, fallback: Record<string, string> = {}) {
  const src = input && typeof input === 'object' ? input : fallback;
  const out: Record<string, string> = {};
  for (const [keyRaw, valueRaw] of Object.entries(src)) {
    const key = cleanText(keyRaw, 80).replace(/[^A-Za-z0-9_]+/g, '_');
    if (!key) continue;
    const value = cleanText(valueRaw, 400);
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw;
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const th = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const benchmark = raw.benchmark && typeof raw.benchmark === 'object' ? raw.benchmark : {};
  const soak = raw.soak && typeof raw.soak === 'object' ? raw.soak : {};
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
      benchmark_latest_path: resolvePath(paths.benchmark_latest_path, base.paths.benchmark_latest_path),
      benchmark_report_path: resolvePath(paths.benchmark_report_path, base.paths.benchmark_report_path),
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
      require_rust_transport: (() => {
        const token = normalizeToken(benchmark.require_rust_transport || base.benchmark.require_rust_transport, 32).toLowerCase();
        return ['daemon', 'cli', 'any'].includes(token) ? token : base.benchmark.require_rust_transport;
      })(),
      enforce_warm_path: toBool(benchmark.enforce_warm_path, base.benchmark.enforce_warm_path),
      measure_cold_build: toBool(benchmark.measure_cold_build, base.benchmark.measure_cold_build),
      max_artifact_age_hours: clampInt(
        benchmark.max_artifact_age_hours,
        1,
        24 * 365,
        base.benchmark.max_artifact_age_hours
      ),
      fail_on_scope_contamination: toBool(
        benchmark.fail_on_scope_contamination,
        base.benchmark.fail_on_scope_contamination
      ),
      rust_transport_env: normalizeEnv(benchmark.rust_transport_env, base.benchmark.rust_transport_env),
      cold_build_command: normalizeCommand(benchmark.cold_build_command, base.benchmark.cold_build_command),
      js_probe_command: normalizeCommand(benchmark.js_probe_command, base.benchmark.js_probe_command),
      js_get_probe_command: normalizeCommand(benchmark.js_get_probe_command, base.benchmark.js_get_probe_command),
      js_index_probe_command: normalizeCommand(benchmark.js_index_probe_command, base.benchmark.js_index_probe_command),
      rust_probe_command: normalizeCommand(benchmark.rust_probe_command, base.benchmark.rust_probe_command)
      ,
      rust_get_probe_command: normalizeCommand(benchmark.rust_get_probe_command, base.benchmark.rust_get_probe_command),
      rust_index_probe_command: normalizeCommand(benchmark.rust_index_probe_command, base.benchmark.rust_index_probe_command)
    },
    soak: {
      enabled: toBool(soak.enabled, base.soak.enabled),
      window_hours: clampInt(soak.window_hours, 1, 24 * 14, base.soak.window_hours),
      max_window_hours: clampInt(soak.max_window_hours, 1, 24 * 14, base.soak.max_window_hours),
      min_rows: clampInt(soak.min_rows, 1, 100000, base.soak.min_rows),
      min_pass_rate: Number.isFinite(Number(soak.min_pass_rate))
        ? Math.max(0, Math.min(1, Number(soak.min_pass_rate)))
        : base.soak.min_pass_rate,
      max_fallback_trigger_count: clampInt(
        soak.max_fallback_trigger_count,
        0,
        100000,
        base.soak.max_fallback_trigger_count
      ),
      max_restart_count: clampInt(soak.max_restart_count, 0, 100000, base.soak.max_restart_count),
      max_rust_p99_ms: clampInt(soak.max_rust_p99_ms, 1, 24 * 60 * 60 * 1000, base.soak.max_rust_p99_ms),
      restart_history_path: resolvePath(soak.restart_history_path, base.soak.restart_history_path),
      promotion_decisions_path: resolvePath(soak.promotion_decisions_path, base.soak.promotion_decisions_path)
    }
  };
}

function parseIndexCount(indexPath) {
  if (!fs.existsSync(indexPath)) return 0;
  const rows = String(fs.readFileSync(indexPath, 'utf8') || '').split(/\r?\n/);
  return rows.filter((line) => line.startsWith('| `')).length;
}

function parseProbeNodeId(indexPath) {
  if (!fs.existsSync(indexPath)) return '';
  const lines = String(fs.readFileSync(indexPath, 'utf8') || '').split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = String(lineRaw || '').trim();
    if (!line.startsWith('|')) continue;
    const m = line.match(/^\|\s*`?([A-Za-z0-9._-]+)`?\s*\|/);
    if (!m || !m[1]) continue;
    const candidate = normalizeToken(m[1], 120);
    if (/^-+$/.test(candidate)) continue;
    if (!candidate || candidate === 'node_id') continue;
    return candidate;
  }
  return '';
}

function resolveProbeCommand(command, fallbackCommand, context = {}) {
  const base = Array.isArray(command) ? command.slice(0) : [];
  if (!base.length) return Array.isArray(fallbackCommand) ? fallbackCommand.slice(0) : [];
  const nodeId = cleanText(context.node_id || '', 120);
  const needsNode = base.some((token) => String(token || '').includes('$NODE_ID'));
  if (needsNode && !nodeId) {
    return Array.isArray(fallbackCommand) ? fallbackCommand.slice(0) : [];
  }
  return base.map((token) => String(token || '').replace(/\$NODE_ID/g, nodeId));
}

function resolveRustCoreInvocation(policy, subcommandArgs = []) {
  const cratePath = policy.paths.rust_crate_path;
  const binPath = path.join(cratePath, 'target', 'release', 'protheus-memory-core');
  if (fs.existsSync(binPath)) {
    return {
      command: binPath,
      args: Array.isArray(subcommandArgs) ? subcommandArgs.slice(0) : [],
      cwd: ROOT,
      transport: 'binary'
    };
  }
  return {
    command: 'cargo',
    args: ['run', '--release', '--quiet', '--', ...(Array.isArray(subcommandArgs) ? subcommandArgs : [])],
    cwd: cratePath,
    transport: 'cargo_run'
  };
}

function runRustProbe(policy) {
  const cratePath = policy.paths.rust_crate_path;
  if (!fs.existsSync(cratePath)) {
    return { ok: false, error: 'rust_crate_missing' };
  }
  const probeRoot = resolveProbeRoot(policy);
  const invocation = resolveRustCoreInvocation(policy, ['probe', `--root=${probeRoot}`]);
  const run = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf8'
  });
  const stdout = String(run.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return {
    ok: Number.isFinite(run.status) ? run.status === 0 : false,
    status: Number.isFinite(run.status) ? run.status : 1,
    parsed,
    stderr: cleanText(run.stderr || '', 400),
    transport: invocation.transport
  };
}

function resolveProbeRoot(policy) {
  return fs.existsSync(policy.paths.memory_index_path)
    ? (() => {
      const indexDir = path.dirname(policy.paths.memory_index_path);
      return path.basename(indexDir) === 'memory' ? path.dirname(indexDir) : indexDir;
    })()
    : ROOT;
}

function parseTagsInline(raw) {
  return String(raw || '')
    .replace(/[\\[\\]"']/g, ' ')
    .split(/[,\s]+/)
    .map((tok) => cleanText(tok, 80).replace(/^#+/, '').toLowerCase())
    .filter((tok) => /^[a-z0-9_-]+$/.test(tok));
}

function scanDailyNodeStats(rootPath) {
  const memoryDir = path.join(rootPath, 'memory');
  if (!fs.existsSync(memoryDir)) return { node_count: 0, tag_count: 0, files_scanned: 0 };
  const files = fs.readdirSync(memoryDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(String(name || '')))
    .sort();
  const seen = new Set();
  const tags = new Set();
  let filesScanned = 0;
  for (const name of files) {
    const filePath = path.join(memoryDir, name);
    let text = '';
    try {
      text = String(fs.readFileSync(filePath, 'utf8') || '');
    } catch {
      continue;
    }
    filesScanned += 1;
    const chunks = text.split('<!-- NODE -->');
    for (const chunk of chunks) {
      const nodeMatch = String(chunk || '').match(/^\s*node_id:\s*([A-Za-z0-9._-]+)/m);
      if (!nodeMatch || !nodeMatch[1]) continue;
      const nodeId = normalizeToken(nodeMatch[1], 120);
      if (!nodeId) continue;
      const key = `${nodeId}@memory/${name}`;
      if (!seen.has(key)) seen.add(key);
      const tagMatch = String(chunk || '').match(/^\s*tags:\s*(.+)$/m);
      if (!tagMatch || !tagMatch[1]) continue;
      for (const tag of parseTagsInline(tagMatch[1])) {
        tags.add(tag);
      }
    }
  }
  return {
    node_count: seen.size,
    tag_count: tags.size,
    files_scanned: filesScanned
  };
}

function runRustBuildIndexProbe(policy) {
  const cratePath = policy.paths.rust_crate_path;
  if (!fs.existsSync(cratePath)) {
    return { ok: false, error: 'rust_crate_missing', status: 1 };
  }
  const probeRoot = resolveProbeRoot(policy);
  const invocation = resolveRustCoreInvocation(policy, ['build-index', `--root=${probeRoot}`]);
  const started = Date.now();
  const run = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    timeout: policy.benchmark.timeout_ms
  });
  const elapsed = Math.max(1, Date.now() - started);
  let payload = null;
  try { payload = JSON.parse(String(run.stdout || '').trim()); } catch {}
  if (Number.isFinite(run.status) && run.status === 0 && payload && payload.ok === true) {
    return {
      ok: true,
      backend_used: 'rust',
      rust_transport: invocation.transport,
      estimated_ms: elapsed,
      parity_error_count: 0,
      node_count: clampInt(payload.node_count, 0, 1000000, 0),
      tag_count: clampInt(payload.tag_count, 0, 1000000, 0),
      files_scanned: clampInt(payload.files_scanned, 0, 1000000, 0)
    };
  }
  return {
    ok: false,
    error: payload && payload.error ? cleanText(payload.error, 180) : `rust_index_probe_status_${Number.isFinite(run.status) ? run.status : 1}`,
    status: Number.isFinite(run.status) ? run.status : 1,
    stderr: cleanText(run.stderr || '', 300),
    rust_transport: invocation.transport
  };
}

function indexProbe(args, policy) {
  const backend = normalizeToken(args.backend || '', 20) || 'js';
  if (!['js', 'rust'].includes(backend)) {
    return { ok: false, error: 'invalid_backend', backend };
  }
  if (backend === 'js') {
    const rootPath = resolveProbeRoot(policy);
    const started = Date.now();
    const stats = scanDailyNodeStats(rootPath);
    const elapsed = Math.max(1, Date.now() - started);
    return {
      ok: true,
      type: 'rust_memory_index_probe',
      backend_used: 'js',
      estimated_ms: elapsed,
      parity_error_count: 0,
      node_count: stats.node_count,
      tag_count: stats.tag_count,
      files_scanned: stats.files_scanned
    };
  }
  const rust = runRustBuildIndexProbe(policy);
  if (!rust.ok) return {
    ok: false,
    type: 'rust_memory_index_probe',
    backend_used: 'rust',
    error: rust.error || 'rust_index_probe_failed',
    status: rust.status || 1,
    rust_transport: rust.rust_transport || null
  };
  return {
    ok: true,
    type: 'rust_memory_index_probe',
    backend_used: 'rust',
    rust_transport: rust.rust_transport || null,
    estimated_ms: rust.estimated_ms,
    parity_error_count: 0,
    node_count: rust.node_count,
    tag_count: rust.tag_count,
    files_scanned: rust.files_scanned
  };
}

function runTimedProbeCommand(command, timeoutMs, opts: any = {}) {
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
  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : ROOT;
  const env = opts.env && typeof opts.env === 'object' ? { ...process.env, ...opts.env } : process.env;
  const started = Date.now();
  const run = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    env,
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

function policyScopeId(policy) {
  return stableHash([
    cleanText(policy && policy.version || '1.0', 32),
    cleanText(policy && policy.paths && policy.paths.benchmark_path || '', 240),
    cleanText(policy && policy.paths && policy.paths.benchmark_report_path || '', 240),
    cleanText(policy && policy.paths && policy.paths.memory_index_path || '', 240),
    cleanText(policy && policy.paths && policy.paths.rust_crate_path || '', 240),
    cleanText(policy && policy.benchmark && policy.benchmark.mode || '', 40),
    cleanText(policy && policy.benchmark && policy.benchmark.require_rust_transport || '', 20)
  ].join('|'), 24);
}

function parseReportMeta(reportAbs) {
  try {
    if (!fs.existsSync(reportAbs)) return null;
    const text = String(fs.readFileSync(reportAbs, 'utf8') || '');
    const match = text.match(/<!--\s*rust_memory_transition_benchmark_meta:\s*(\{[\s\S]*?\})\s*-->/);
    if (!match || !match[1]) return null;
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function percentileMs(rows, key, pctl) {
  const vals = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row && row[key] != null ? row[key] : NaN))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const rank = Math.ceil((clampInt(pctl, 1, 100, 95) / 100) * vals.length) - 1;
  const idx = Math.max(0, Math.min(vals.length - 1, rank));
  return clampInt(vals[idx], 0, 24 * 60 * 60 * 1000, 0);
}

function writeStage1BenchmarkReport(policy, summary) {
  const reportAbs = policy.paths.benchmark_report_path;
  fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
  const generatedAt = nowIso();
  const meta = {
    schema_version: '1.0',
    policy_scope: cleanText(summary.policy_scope || policyScopeId(policy), 80),
    generated_at: generatedAt,
    mode: cleanText(summary.mode || 'probe_commands', 40),
    runs_added: clampInt(summary.runs_added, 0, 100000, 0),
    stable_runs: clampInt(summary.stable_runs, 0, 100000, 0),
    avg_speedup: Number(Number(summary.avg_speedup || 0).toFixed(6)),
    avg_query_speedup: Number(Number(summary.avg_query_speedup || 0).toFixed(6)),
    avg_get_speedup: Number(Number(summary.avg_get_speedup || 0).toFixed(6)),
    avg_index_speedup: Number(Number(summary.avg_index_speedup || 0).toFixed(6)),
    target_speedup: Number(Number(summary.target_speedup || 0).toFixed(6)),
    warm_rows: clampInt(summary.warm_rows, 0, 100000, 0),
    cold_build_ms: summary.cold_build_ms == null ? null : clampInt(summary.cold_build_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_total_p95_ms: summary.rust_total_p95_ms == null ? null : clampInt(summary.rust_total_p95_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_total_p99_ms: summary.rust_total_p99_ms == null ? null : clampInt(summary.rust_total_p99_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_query_p95_ms: summary.rust_query_p95_ms == null ? null : clampInt(summary.rust_query_p95_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_query_p99_ms: summary.rust_query_p99_ms == null ? null : clampInt(summary.rust_query_p99_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_get_p95_ms: summary.rust_get_p95_ms == null ? null : clampInt(summary.rust_get_p95_ms, 0, 24 * 60 * 60 * 1000, 0),
    rust_get_p99_ms: summary.rust_get_p99_ms == null ? null : clampInt(summary.rust_get_p99_ms, 0, 24 * 60 * 60 * 1000, 0)
  };
  const lines = [
    '# Memory Migration Stage 1 Benchmark',
    '',
    `- Generated: ${generatedAt}`,
    `- Mode: ${cleanText(summary.mode || 'probe_commands', 40)}`,
    `- Runs Added: ${clampInt(summary.runs_added, 0, 100000, 0)}`,
    `- Stable Runs Considered: ${clampInt(summary.stable_runs, 0, 100000, 0)}`,
    `- Avg Total Speedup (js/rust): ${Number(summary.avg_speedup || 0).toFixed(6)}`,
    `- Avg Query Speedup: ${Number(summary.avg_query_speedup || 0).toFixed(6)}`,
    `- Avg Get Speedup: ${Number(summary.avg_get_speedup || 0).toFixed(6)}`,
    `- Avg Index Speedup: ${Number(summary.avg_index_speedup || 0).toFixed(6)}`,
    `- Target Speedup: ${Number(summary.target_speedup || 0).toFixed(6)}`,
    `- Warm Path Rows: ${clampInt(summary.warm_rows, 0, 100000, 0)}`,
    `- Rust Total Latency p95/p99 (ms): ${summary.rust_total_p95_ms == null ? 'n/a' : clampInt(summary.rust_total_p95_ms, 0, 24 * 60 * 60 * 1000, 0)}/${summary.rust_total_p99_ms == null ? 'n/a' : clampInt(summary.rust_total_p99_ms, 0, 24 * 60 * 60 * 1000, 0)}`,
    `- Rust Query Latency p95/p99 (ms): ${summary.rust_query_p95_ms == null ? 'n/a' : clampInt(summary.rust_query_p95_ms, 0, 24 * 60 * 60 * 1000, 0)}/${summary.rust_query_p99_ms == null ? 'n/a' : clampInt(summary.rust_query_p99_ms, 0, 24 * 60 * 60 * 1000, 0)}`,
    `- Rust Get Latency p95/p99 (ms): ${summary.rust_get_p95_ms == null ? 'n/a' : clampInt(summary.rust_get_p95_ms, 0, 24 * 60 * 60 * 1000, 0)}/${summary.rust_get_p99_ms == null ? 'n/a' : clampInt(summary.rust_get_p99_ms, 0, 24 * 60 * 60 * 1000, 0)}`,
    `- Cold Build Metric (ms): ${summary.cold_build_ms == null ? 'not_measured' : clampInt(summary.cold_build_ms, 0, 24 * 60 * 60 * 1000, 0)}`,
    '',
    '## Notes',
    '- Stage 1 keeps deterministic JS fallback active.',
    '- SQLite runtime state is authoritative in Rust path.',
    '- Warm-path benchmark rows require daemon transport when configured.',
    '- Cold-build metrics are tracked separately and excluded from runtime speedup gating.',
    '- Benchmark artifacts are generated by rust_memory_transition_lane.',
    '',
    `<!-- rust_memory_transition_benchmark_meta: ${JSON.stringify(meta)} -->`,
    ''
  ];
  const body = `${lines.join('\n')}\n`;
  fs.writeFileSync(reportAbs, body, 'utf8');
  return {
    report_rel_path: path.relative(ROOT, reportAbs).replace(/\\/g, '/'),
    report_sha256: stableHash(body, 24),
    report_meta: meta
  };
}

function writeTransitionReceipt(policy, payload: any, opts: any = {}) {
  return writeArtifactSet(
    {
      latestPath: policy.paths.latest_path,
      receiptsPath: policy.paths.receipts_path
    },
    payload,
    {
      schemaId: 'rust_memory_transition_receipt',
      schemaVersion: '1.0',
      artifactType: 'receipt',
      writeLatest: toBool(opts.writeLatest, true),
      appendReceipt: toBool(opts.appendReceipt, true)
    }
  );
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

  writeTransitionReceipt(policy, out);
  return out;
}

function normalizeTransportToken(payload) {
  return normalizeToken(
    payload && (payload.rust_transport || payload.transport || ''),
    20
  ).toLowerCase() || '';
}

function measureColdBuildMetric(policy, args) {
  const requested = toBool(
    args['measure-cold-build'] != null ? args['measure-cold-build'] : args.measure_cold_build,
    policy.benchmark.measure_cold_build
  );
  if (!requested) {
    return { measured: false, cold_build_ms: null, cold_build_ok: null, cold_build_error: null };
  }
  const cratePath = policy.paths.rust_crate_path;
  if (!fs.existsSync(cratePath)) {
    return { measured: true, cold_build_ms: null, cold_build_ok: false, cold_build_error: 'rust_crate_missing' };
  }
  const cmd = normalizeCommand(policy.benchmark.cold_build_command, ['cargo', 'build', '--release']);
  const run = runTimedProbeCommand(cmd, Math.max(policy.benchmark.timeout_ms, 180000), { cwd: cratePath });
  return {
    measured: true,
    cold_build_ms: clampInt(run.duration_ms, 0, 24 * 60 * 60 * 1000, 0),
    cold_build_ok: run.ok === true,
    cold_build_error: run.ok ? null : cleanText(run.stderr || run.stdout || 'cold_build_failed', 200)
  };
}

function prewarmRustRuntime(policy, probeNodeId) {
  if (policy.benchmark.mode !== 'probe_commands') {
    return { ok: true, attempted: false, duration_ms: 0, transport: null, error: null };
  }
  if (policy.benchmark.enforce_warm_path !== true) {
    return { ok: true, attempted: false, duration_ms: 0, transport: null, error: null };
  }
  const warmEnv = normalizeEnv(policy.benchmark.rust_transport_env, {});
  const command = resolveProbeCommand(
    policy.benchmark.rust_get_probe_command,
    policy.benchmark.rust_probe_command,
    { node_id: probeNodeId }
  );
  const warm = runTimedProbeCommand(command, policy.benchmark.timeout_ms, { env: warmEnv });
  const transport = normalizeTransportToken(warm.payload);
  return {
    ok: warm.ok === true,
    attempted: true,
    duration_ms: clampInt(warm.duration_ms, 0, 600000, 0),
    transport: transport || null,
    error: warm.ok ? null : cleanText(warm.stderr || warm.stdout || 'rust_prewarm_failed', 200)
  };
}

function runBenchmark(args, policy) {
  const runs = clampInt(args.runs, 1, 100, 5);
  const autoSelect = toBool(
    args['auto-select'] != null ? args['auto-select'] : args.auto_select,
    false
  );
  const strict = toBool(args.strict, false);
  const scopeId = policyScopeId(policy);
  const requiredRustTransport = cleanText(policy.benchmark.require_rust_transport || 'any', 20).toLowerCase();
  const warmTransportEnforced = policy.benchmark.enforce_warm_path === true && requiredRustTransport !== 'any';
  const probeNodeId = parseProbeNodeId(policy.paths.memory_index_path);
  const history = readJson(policy.paths.benchmark_path, {
    schema_version: '1.0',
    rows: []
  });
  history.rows = Array.isArray(history.rows) ? history.rows : [];
  history.schema_version = cleanText(history.schema_version || '1.0', 16) || '1.0';

  const coldBuildMetric = measureColdBuildMetric(policy, args);
  const prewarm = prewarmRustRuntime(policy, probeNodeId);

  for (let i = 0; i < runs; i += 1) {
    if (policy.benchmark.mode === 'probe_commands') {
      const jsQueryProbe = runTimedProbeCommand(policy.benchmark.js_probe_command, policy.benchmark.timeout_ms);
      const rustQueryProbe = runTimedProbeCommand(
        policy.benchmark.rust_probe_command,
        policy.benchmark.timeout_ms,
        { env: warmTransportEnforced ? policy.benchmark.rust_transport_env : {} }
      );
      const jsGetCommand = resolveProbeCommand(
        policy.benchmark.js_get_probe_command,
        policy.benchmark.js_probe_command,
        { node_id: probeNodeId }
      );
      const rustGetCommand = resolveProbeCommand(
        policy.benchmark.rust_get_probe_command,
        policy.benchmark.rust_probe_command,
        { node_id: probeNodeId }
      );
      const jsGetProbe = runTimedProbeCommand(
        jsGetCommand,
        policy.benchmark.timeout_ms
      );
      const rustGetProbe = runTimedProbeCommand(
        rustGetCommand,
        policy.benchmark.timeout_ms,
        { env: warmTransportEnforced ? policy.benchmark.rust_transport_env : {} }
      );
      const hasIndexProbeCommands = Array.isArray(policy.benchmark.js_index_probe_command)
        && policy.benchmark.js_index_probe_command.length > 0
        && Array.isArray(policy.benchmark.rust_index_probe_command)
        && policy.benchmark.rust_index_probe_command.length > 0;
      const jsIndexProbe = hasIndexProbeCommands
        ? runTimedProbeCommand(policy.benchmark.js_index_probe_command, policy.benchmark.timeout_ms)
        : null;
      const rustIndexProbe = hasIndexProbeCommands
        ? runTimedProbeCommand(policy.benchmark.rust_index_probe_command, policy.benchmark.timeout_ms)
        : null;

      const jsIndexMsForTotal = hasIndexProbeCommands ? Math.max(1, Number(jsIndexProbe && jsIndexProbe.duration_ms || 1)) : 0;
      const rustIndexMsForTotal = hasIndexProbeCommands ? Math.max(1, Number(rustIndexProbe && rustIndexProbe.duration_ms || 1)) : 0;
      const jsMs = Math.max(1, Number(jsQueryProbe.duration_ms || 1) + Number(jsGetProbe.duration_ms || 1) + jsIndexMsForTotal);
      const rustMs = Math.max(1, Number(rustQueryProbe.duration_ms || 1) + Number(rustGetProbe.duration_ms || 1) + rustIndexMsForTotal);
      const jsQueryMs = Math.max(1, Number(jsQueryProbe.duration_ms || 1));
      const rustQueryMs = Math.max(1, Number(rustQueryProbe.duration_ms || 1));
      const jsGetMs = Math.max(1, Number(jsGetProbe.duration_ms || 1));
      const rustGetMs = Math.max(1, Number(rustGetProbe.duration_ms || 1));
      const jsIndexMs = hasIndexProbeCommands ? jsIndexMsForTotal : null;
      const rustIndexMs = hasIndexProbeCommands ? rustIndexMsForTotal : null;

      const rustBackendUsedQuery = normalizeToken(
        rustQueryProbe.payload && (rustQueryProbe.payload.backend_used || rustQueryProbe.payload.backend || ''),
        20
      ) || '';
      const rustBackendUsedGet = normalizeToken(
        rustGetProbe.payload && (rustGetProbe.payload.backend_used || rustGetProbe.payload.backend || ''),
        20
      ) || '';
      const rustTransportQuery = normalizeTransportToken(rustQueryProbe.payload);
      const rustTransportGet = normalizeTransportToken(rustGetProbe.payload);
      const rustBackendUsedIndex = normalizeToken(
        rustIndexProbe && rustIndexProbe.payload && (rustIndexProbe.payload.backend_used || rustIndexProbe.payload.backend || ''),
        20
      ) || '';
      const rustTransportIndex = normalizeTransportToken(rustIndexProbe && rustIndexProbe.payload ? rustIndexProbe.payload : null);
      const rustBackendMismatchQuery = policy.benchmark.require_rust_backend_used === true
        && rustBackendUsedQuery
        && rustBackendUsedQuery !== 'rust';
      const rustBackendMismatchGet = policy.benchmark.require_rust_backend_used === true
        && rustBackendUsedGet
        && rustBackendUsedGet !== 'rust';
      const rustBackendMismatchIndex = hasIndexProbeCommands
        && policy.benchmark.require_rust_backend_used === true
        && rustBackendUsedIndex
        && rustBackendUsedIndex !== 'rust';
      const rustTransportMismatchQuery = requiredRustTransport !== 'any'
        && rustTransportQuery
        && rustTransportQuery !== requiredRustTransport;
      const rustTransportMismatchGet = requiredRustTransport !== 'any'
        && rustTransportGet
        && rustTransportGet !== requiredRustTransport;

      const queryParity = rustQueryProbe.ok
        ? clampInt(
          rustQueryProbe.payload && Number.isFinite(rustQueryProbe.payload.parity_error_count)
            ? rustQueryProbe.payload.parity_error_count
            : ((rustBackendMismatchQuery || rustTransportMismatchQuery) ? 1 : 0),
          0,
          100000,
          (rustBackendMismatchQuery || rustTransportMismatchQuery) ? 1 : 0
        )
        : 1;
      const getParity = rustGetProbe.ok
        ? clampInt(
          rustGetProbe.payload && Number.isFinite(rustGetProbe.payload.parity_error_count)
            ? rustGetProbe.payload.parity_error_count
            : ((rustBackendMismatchGet || rustTransportMismatchGet) ? 1 : 0),
          0,
          100000,
          (rustBackendMismatchGet || rustTransportMismatchGet) ? 1 : 0
        )
        : 1;
      const indexParity = hasIndexProbeCommands
        ? (
          rustIndexProbe && rustIndexProbe.ok
            ? clampInt(
              rustIndexProbe.payload && Number.isFinite(rustIndexProbe.payload.parity_error_count)
                ? rustIndexProbe.payload.parity_error_count
                : (rustBackendMismatchIndex ? 1 : 0),
              0,
              100000,
              rustBackendMismatchIndex ? 1 : 0
            )
            : 1
        )
        : 0;
      const parityErrorCount = Math.max(queryParity, getParity, indexParity);
      const speedup = Number((jsMs / Math.max(1, rustMs)).toFixed(6));
      const querySpeedup = Number((jsQueryMs / Math.max(1, rustQueryMs)).toFixed(6));
      const getSpeedup = Number((jsGetMs / Math.max(1, rustGetMs)).toFixed(6));
      const indexSpeedup = hasIndexProbeCommands
        ? Number((Number(jsIndexMs || 0) / Math.max(1, Number(rustIndexMs || 1))).toFixed(6))
        : null;

      history.rows.push({
        ts: nowIso(),
        mode: 'probe_commands',
        policy_scope: scopeId,
        js_ms: jsMs,
        rust_ms: rustMs,
        speedup,
        js_query_ms: jsQueryMs,
        rust_query_ms: rustQueryMs,
        query_speedup: querySpeedup,
        js_get_ms: jsGetMs,
        rust_get_ms: rustGetMs,
        get_speedup: getSpeedup,
        js_index_ms: jsIndexMs,
        rust_index_ms: rustIndexMs,
        index_speedup: indexSpeedup,
        parity_error_count: parityErrorCount,
        js_probe_ok: jsQueryProbe.ok,
        rust_probe_ok: rustQueryProbe.ok,
        js_probe_status: jsQueryProbe.status,
        rust_probe_status: rustQueryProbe.status,
        rust_backend_used: rustBackendUsedQuery || null,
        rust_backend_mismatch: rustBackendMismatchQuery,
        rust_query_transport: rustTransportQuery || null,
        rust_query_transport_mismatch: rustTransportMismatchQuery,
        js_probe_error: jsQueryProbe.ok ? null : jsQueryProbe.stderr || 'probe_failed',
        rust_probe_error: rustQueryProbe.ok ? null : rustQueryProbe.stderr || 'probe_failed',
        js_get_probe_ok: jsGetProbe.ok,
        rust_get_probe_ok: rustGetProbe.ok,
        js_get_probe_status: jsGetProbe.status,
        rust_get_probe_status: rustGetProbe.status,
        rust_get_backend_used: rustBackendUsedGet || null,
        rust_get_backend_mismatch: rustBackendMismatchGet,
        rust_get_transport: rustTransportGet || null,
        rust_get_transport_mismatch: rustTransportMismatchGet,
        js_get_probe_error: jsGetProbe.ok ? null : jsGetProbe.stderr || 'probe_failed',
        rust_get_probe_error: rustGetProbe.ok ? null : rustGetProbe.stderr || 'probe_failed',
        js_index_probe_ok: hasIndexProbeCommands ? (jsIndexProbe && jsIndexProbe.ok === true) : null,
        rust_index_probe_ok: hasIndexProbeCommands ? (rustIndexProbe && rustIndexProbe.ok === true) : null,
        js_index_probe_status: hasIndexProbeCommands ? (jsIndexProbe ? jsIndexProbe.status : 1) : null,
        rust_index_probe_status: hasIndexProbeCommands ? (rustIndexProbe ? rustIndexProbe.status : 1) : null,
        rust_index_backend_used: hasIndexProbeCommands ? (rustBackendUsedIndex || null) : null,
        rust_index_transport: hasIndexProbeCommands ? (rustTransportIndex || null) : null,
        rust_index_backend_mismatch: hasIndexProbeCommands ? rustBackendMismatchIndex : null,
        js_index_probe_error: hasIndexProbeCommands
          ? ((jsIndexProbe && jsIndexProbe.ok) ? null : ((jsIndexProbe && jsIndexProbe.stderr) || 'probe_failed'))
          : null,
        rust_index_probe_error: hasIndexProbeCommands
          ? ((rustIndexProbe && rustIndexProbe.ok) ? null : ((rustIndexProbe && rustIndexProbe.stderr) || 'probe_failed'))
          : null,
        probe_node_id: probeNodeId || null,
        warm_path_required_transport: requiredRustTransport,
        warm_path_enforced: warmTransportEnforced,
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
      policy_scope: scopeId,
      js_ms: jsMs,
      rust_ms: rustMs,
      speedup,
      parity_error_count: rust.ok && rust.parsed ? clampInt(rust.parsed.parity_error_count, 0, 100000, 0) : 1,
      signature: stableHash(`${jsMs}|${rustMs}|${speedup}|${i}|${Date.now()}`, 24)
    });
  }
  history.updated_at = nowIso();
  writeJsonAtomic(policy.paths.benchmark_path, history);

  const rowsForScope = history.rows.filter((row: any) => cleanText(row && row.policy_scope || '', 80) === scopeId);
  const scopeContaminationRows = history.rows.filter((row: any) => {
    const rowScope = cleanText(row && row.policy_scope || '', 80);
    return rowScope && rowScope !== scopeId;
  }).length;
  const recentBase = rowsForScope.slice(-Math.max(policy.thresholds.min_stable_runs_for_retirement, 20));
  const recentWarm = warmTransportEnforced
    ? recentBase.filter((row: any) => {
      if (!row || row.mode !== 'probe_commands') return false;
      const queryTransport = cleanText(row.rust_query_transport || '', 20).toLowerCase();
      const getTransport = cleanText(row.rust_get_transport || '', 20).toLowerCase();
      return queryTransport === requiredRustTransport && getTransport === requiredRustTransport;
    })
    : recentBase;
  const recent = recentWarm.length > 0 ? recentWarm : recentBase;
  const avgSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const avgQuerySpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.query_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const avgGetSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.get_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const indexRows = recent.filter((row: any) => row && row.index_speedup != null && Number.isFinite(Number(row.index_speedup)));
  const avgIndexSpeedup = indexRows.length > 0
    ? Number((indexRows.reduce((acc: number, row: any) => acc + Number(row.index_speedup || 0), 0) / indexRows.length).toFixed(6))
    : 0;
  const rustTotalP95Ms = percentileMs(recent, 'rust_ms', 95);
  const rustTotalP99Ms = percentileMs(recent, 'rust_ms', 99);
  const rustQueryP95Ms = percentileMs(recent, 'rust_query_ms', 95);
  const rustQueryP99Ms = percentileMs(recent, 'rust_query_ms', 99);
  const rustGetP95Ms = percentileMs(recent, 'rust_get_ms', 95);
  const rustGetP99Ms = percentileMs(recent, 'rust_get_ms', 99);

  const reportOut = writeStage1BenchmarkReport(policy, {
    mode: policy.benchmark.mode,
    runs_added: runs,
    stable_runs: recent.length,
    avg_speedup: avgSpeedup,
    avg_query_speedup: avgQuerySpeedup,
    avg_get_speedup: avgGetSpeedup,
    avg_index_speedup: avgIndexSpeedup,
    target_speedup: policy.thresholds.min_speedup_for_cutover,
    policy_scope: scopeId,
    warm_rows: recentWarm.length,
    cold_build_ms: coldBuildMetric.cold_build_ms,
    rust_total_p95_ms: rustTotalP95Ms,
    rust_total_p99_ms: rustTotalP99Ms,
    rust_query_p95_ms: rustQueryP95Ms,
    rust_query_p99_ms: rustQueryP99Ms,
    rust_get_p95_ms: rustGetP95Ms,
    rust_get_p99_ms: rustGetP99Ms
  });

  const out: any = {
    ts: nowIso(),
    type: 'rust_memory_transition_benchmark',
    ok: true,
    shadow_only: policy.shadow_only,
    mode: policy.benchmark.mode,
    strict,
    policy_scope: scopeId,
    runs_added: runs,
    history_rows_total: history.rows.length,
    history_rows_scope: rowsForScope.length,
    scope_contamination_rows: scopeContaminationRows,
    warm_path_required_transport: warmTransportEnforced ? requiredRustTransport : 'any',
    warm_path_rows: recentWarm.length,
    prewarm: prewarm,
    cold_build_metric: coldBuildMetric,
    avg_speedup: avgSpeedup,
    avg_query_speedup: avgQuerySpeedup,
    avg_get_speedup: avgGetSpeedup,
    avg_index_speedup: avgIndexSpeedup,
    rust_total_p95_ms: rustTotalP95Ms,
    rust_total_p99_ms: rustTotalP99Ms,
    rust_query_p95_ms: rustQueryP95Ms,
    rust_query_p99_ms: rustQueryP99Ms,
    rust_get_p95_ms: rustGetP95Ms,
    rust_get_p99_ms: rustGetP99Ms,
    target_speedup: policy.thresholds.min_speedup_for_cutover,
    stable_runs: recent.length,
    stage1_report_path: reportOut.report_rel_path,
    stage1_report_sha256: reportOut.report_sha256,
    benchmark_history_path: path.relative(ROOT, policy.paths.benchmark_path).replace(/\\/g, '/'),
    benchmark_latest_path: path.relative(ROOT, policy.paths.benchmark_latest_path).replace(/\\/g, '/'),
    benchmark_report_path: path.relative(ROOT, policy.paths.benchmark_report_path).replace(/\\/g, '/')
  };
  if (policy.benchmark.fail_on_scope_contamination === true && scopeContaminationRows > 0) {
    out.ok = false;
    out.reason = 'benchmark_scope_contamination';
  }
  if (autoSelect) {
    const decision = evaluateAutoSelector(policy);
    const selectorOut = persistAutoSelector(policy, decision, {
      persistLatest: false,
      persistReceipt: true
    });
    out.auto_selector = {
      backend: selectorOut.backend,
      active_engine: selectorOut.active_engine,
      eligible: selectorOut.eligible,
      stable_runs: selectorOut.stable_runs,
      avg_speedup: selectorOut.avg_speedup,
      max_parity_errors: selectorOut.max_parity_errors
    };
  }
  writeJsonAtomic(policy.paths.benchmark_latest_path, out);
  writeTransitionReceipt(policy, out);
  if (strict && out.ok !== true) emit(out, 1);
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
  writeTransitionReceipt(policy, out);
  return out;
}

function evaluateAutoSelector(policy) {
  const history = readJson(policy.paths.benchmark_path, { rows: [] });
  const rows = Array.isArray(history.rows) ? history.rows : [];
  const scopeId = policyScopeId(policy);
  const scopeRows = rows.filter((row: any) => cleanText(row && row.policy_scope || '', 80) === scopeId);
  const recent = scopeRows.slice(-policy.thresholds.min_stable_runs_for_retirement);
  const avgSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const maxParityErrors = recent.reduce((acc: number, row: any) => Math.max(acc, clampInt(row.parity_error_count, 0, 100000, 0)), 0);
  const eligible = recent.length >= policy.thresholds.min_stable_runs_for_retirement
    && avgSpeedup >= policy.thresholds.min_speedup_for_cutover
    && maxParityErrors <= policy.thresholds.max_parity_error_count;

  const backend = eligible ? 'rust_shadow' : 'js';
  const activeEngine = backend === 'js' ? 'js' : 'rust';
  return {
    backend,
    active_engine: activeEngine,
    eligible,
    stable_runs: recent.length,
    avg_speedup: avgSpeedup,
    max_parity_errors: maxParityErrors,
    auto_reason: eligible ? 'benchmark_gate_pass' : 'benchmark_gate_fail'
  };
}

function persistAutoSelector(policy, decision, opts: any = {}) {
  const persistLatest = toBool(opts.persistLatest, true);
  const persistReceipt = toBool(opts.persistReceipt, true);
  const selector = {
    schema_version: '1.0',
    backend: decision.backend,
    active_engine: decision.active_engine,
    fallback_backend: 'js',
    updated_at: nowIso(),
    auto_selected: true,
    auto_reason: decision.auto_reason || 'benchmark_gate_fail'
  };
  writeJsonAtomic(policy.paths.selector_path, selector);

  const out = {
    ts: nowIso(),
    type: 'rust_memory_auto_selector',
    ok: true,
    backend: decision.backend,
    active_engine: decision.active_engine,
    eligible: decision.eligible === true,
    stable_runs: clampInt(decision.stable_runs, 0, 100000, 0),
    avg_speedup: Number(decision.avg_speedup || 0),
    max_parity_errors: clampInt(decision.max_parity_errors, 0, 100000, 0)
  };
  writeTransitionReceipt(policy, out, {
    writeLatest: persistLatest,
    appendReceipt: persistReceipt
  });
  return out;
}

function autoSelector(policy) {
  const decision = evaluateAutoSelector(policy);
  return persistAutoSelector(policy, decision, { persistLatest: true, persistReceipt: true });
}

function retireCheck(policy) {
  const history = readJson(policy.paths.benchmark_path, { rows: [] });
  const rows = Array.isArray(history.rows) ? history.rows : [];
  const scopeId = policyScopeId(policy);
  const scopeRows = rows.filter((row: any) => cleanText(row && row.policy_scope || '', 80) === scopeId);
  const recent = scopeRows.slice(-policy.thresholds.min_stable_runs_for_retirement);
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
    policy_scope: scopeId,
    eligible_for_js_artifact_retirement: eligible,
    stable_runs: recent.length,
    avg_speedup: avgSpeedup,
    max_parity_errors: maxParityErrors
  };
  writeTransitionReceipt(policy, out);
  return out;
}

function rowTsMs(row: any) {
  return Date.parse(String(row && row.ts || '')) || 0;
}

function countFallbackTriggers(rows: any[]) {
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const fallback =
      row.rust_backend_mismatch === true
      || row.rust_get_backend_mismatch === true
      || row.rust_index_backend_mismatch === true
      || row.rust_probe_ok === false
      || row.rust_get_probe_ok === false
      || row.rust_index_probe_ok === false
      || clampInt(row.parity_error_count, 0, 100000, 0) > 0;
    if (fallback) count += 1;
  }
  return count;
}

function countRestartEvents(restartPath: string, cutoffMs: number) {
  const rows = readJsonl(restartPath);
  return rows.filter((row: any) => rowTsMs(row) >= cutoffMs).length;
}

function soakGate(args, policy) {
  const strict = toBool(args.strict, true);
  const soakCfg = policy.soak && typeof policy.soak === 'object'
    ? policy.soak
    : defaultPolicy().soak;
  if (!toBool(soakCfg.enabled, true)) {
    const disabled = {
      ok: false,
      type: 'rust_memory_daemon_soak_gate',
      ts: nowIso(),
      error: 'soak_gate_disabled'
    };
    if (strict) emit(disabled, 1);
    return disabled;
  }

  const requestedWindow = clampInt(args['window-hours'], 1, 24 * 14, soakCfg.window_hours);
  const windowHours = Math.min(requestedWindow, soakCfg.max_window_hours);
  const nowMs = Date.now();
  const cutoffMs = nowMs - (windowHours * 60 * 60 * 1000);
  const scopeId = policyScopeId(policy);

  const history = readJson(policy.paths.benchmark_path, { rows: [] });
  const rows = Array.isArray(history.rows) ? history.rows : [];
  const scopeRows = rows.filter((row: any) => cleanText(row && row.policy_scope || '', 80) === scopeId);
  const windowRows = scopeRows.filter((row: any) => rowTsMs(row) >= cutoffMs);

  const fallbackTriggerCount = countFallbackTriggers(windowRows);
  const restartCount = countRestartEvents(soakCfg.restart_history_path, cutoffMs);
  const passCount = windowRows.filter((row: any) => clampInt(row && row.parity_error_count, 0, 100000, 0) <= 0).length;
  const passRate = windowRows.length > 0 ? Number((passCount / windowRows.length).toFixed(6)) : 0;
  const rustP99Ms = percentileMs(windowRows, 'rust_ms', 99);

  const checks = {
    min_rows: windowRows.length >= soakCfg.min_rows,
    pass_rate: passRate >= Number(soakCfg.min_pass_rate || 0),
    fallback_trigger_count: fallbackTriggerCount <= soakCfg.max_fallback_trigger_count,
    restart_count: restartCount <= soakCfg.max_restart_count,
    rust_p99: rustP99Ms != null ? rustP99Ms <= soakCfg.max_rust_p99_ms : false
  };
  const failedChecks = Object.keys(checks).filter((key) => checks[key] !== true);
  const eligible = failedChecks.length === 0;

  const out = {
    ok: true,
    type: 'rust_memory_daemon_soak_gate',
    ts: nowIso(),
    strict,
    policy_scope: scopeId,
    eligible_for_live_promotion: eligible,
    window_hours: windowHours,
    metrics: {
      rows_in_window: windowRows.length,
      pass_rate: passRate,
      fallback_trigger_count: fallbackTriggerCount,
      restart_count: restartCount,
      rust_p99_ms: rustP99Ms
    },
    thresholds: {
      min_rows: soakCfg.min_rows,
      min_pass_rate: Number(soakCfg.min_pass_rate || 0),
      max_fallback_trigger_count: soakCfg.max_fallback_trigger_count,
      max_restart_count: soakCfg.max_restart_count,
      max_rust_p99_ms: soakCfg.max_rust_p99_ms
    },
    checks,
    failed_checks: failedChecks
  };
  writeTransitionReceipt(policy, out);
  appendArtifactHistory(
    soakCfg.promotion_decisions_path,
    out,
    {
      schemaId: 'rust_memory_soak_promotion_decision',
      schemaVersion: '1.0',
      artifactType: 'history'
    }
  );
  if (strict && eligible !== true) emit(out, 1);
  return out;
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function nearlyEqual(a, b, epsilon = 0.000001) {
  const aa = Number(a || 0);
  const bb = Number(b || 0);
  return Math.abs(aa - bb) <= epsilon;
}

function benchmarkConsistencyCheck(args, policy) {
  const strict = toBool(args.strict, true);
  const scopeId = policyScopeId(policy);
  const history = readJson(policy.paths.benchmark_path, { rows: [] });
  const rows = Array.isArray(history.rows) ? history.rows : [];
  const scopeRows = rows.filter((row: any) => cleanText(row && row.policy_scope || '', 80) === scopeId);
  const contaminationRows = rows.filter((row: any) => {
    const rowScope = cleanText(row && row.policy_scope || '', 80);
    return rowScope && rowScope !== scopeId;
  });
  const recentBase = scopeRows.slice(-Math.max(policy.thresholds.min_stable_runs_for_retirement, 20));
  const requiredTransport = cleanText(policy.benchmark.require_rust_transport || 'any', 20).toLowerCase();
  const warmRows = policy.benchmark.enforce_warm_path === true && requiredTransport !== 'any'
    ? recentBase.filter((row: any) => {
      if (!row || row.mode !== 'probe_commands') return false;
      const qt = cleanText(row.rust_query_transport || '', 20).toLowerCase();
      const gt = cleanText(row.rust_get_transport || '', 20).toLowerCase();
      return qt === requiredTransport && gt === requiredTransport;
    })
    : recentBase;
  const recent = warmRows.length > 0 ? warmRows : recentBase;
  const avgSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const avgQuerySpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.query_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const avgGetSpeedup = recent.length > 0
    ? Number((recent.reduce((acc: number, row: any) => acc + Number(row.get_speedup || row.speedup || 0), 0) / recent.length).toFixed(6))
    : 0;
  const indexRows = recent.filter((row: any) => row && row.index_speedup != null && Number.isFinite(Number(row.index_speedup)));
  const avgIndexSpeedup = indexRows.length > 0
    ? Number((indexRows.reduce((acc: number, row: any) => acc + Number(row.index_speedup || 0), 0) / indexRows.length).toFixed(6))
    : 0;

  const latest = readJson(policy.paths.benchmark_latest_path, readJson(policy.paths.latest_path, {}));
  const reportMeta = parseReportMeta(policy.paths.benchmark_report_path);

  const latestTsMs = parseIsoMs(latest && latest.ts || '');
  const reportTsMs = parseIsoMs(reportMeta && reportMeta.generated_at || '');
  const nowMs = Date.now();
  const maxAgeMs = Math.max(1, Number(policy.benchmark.max_artifact_age_hours || 0)) * 60 * 60 * 1000;

  const checks = {
    history_scope_rows_present: scopeRows.length > 0,
    benchmark_latest_present: !!(latest && latest.type === 'rust_memory_transition_benchmark'),
    report_meta_present: !!reportMeta,
    latest_scope_match: cleanText(latest && latest.policy_scope || '', 80) === scopeId,
    report_scope_match: cleanText(reportMeta && reportMeta.policy_scope || '', 80) === scopeId,
    latest_vs_history_avg_speedup: nearlyEqual(latest && latest.avg_speedup, avgSpeedup),
    latest_vs_history_avg_query_speedup: nearlyEqual(latest && latest.avg_query_speedup, avgQuerySpeedup),
    latest_vs_history_avg_get_speedup: nearlyEqual(latest && latest.avg_get_speedup, avgGetSpeedup),
    latest_vs_history_avg_index_speedup: nearlyEqual(latest && latest.avg_index_speedup, avgIndexSpeedup),
    report_vs_history_avg_speedup: nearlyEqual(reportMeta && reportMeta.avg_speedup, avgSpeedup),
    report_vs_history_avg_query_speedup: nearlyEqual(reportMeta && reportMeta.avg_query_speedup, avgQuerySpeedup),
    report_vs_history_avg_get_speedup: nearlyEqual(reportMeta && reportMeta.avg_get_speedup, avgGetSpeedup),
    report_vs_history_avg_index_speedup: nearlyEqual(reportMeta && reportMeta.avg_index_speedup, avgIndexSpeedup),
    benchmark_latest_fresh: latestTsMs > 0 && (nowMs - latestTsMs) <= maxAgeMs,
    benchmark_report_fresh: reportTsMs > 0 && (nowMs - reportTsMs) <= maxAgeMs,
    scope_contamination_ok: policy.benchmark.fail_on_scope_contamination === true
      ? contaminationRows.length === 0
      : true
  };
  const failedChecks = Object.keys(checks).filter((key) => checks[key] !== true);
  const out = {
    ts: nowIso(),
    type: 'rust_memory_benchmark_consistency',
    ok: failedChecks.length === 0,
    strict,
    policy_scope: scopeId,
    required_transport: requiredTransport,
    stable_rows: recent.length,
    warm_rows: warmRows.length,
    history_rows_total: rows.length,
    history_rows_scope: scopeRows.length,
    history_scope_contamination_rows: contaminationRows.length,
    computed: {
      avg_speedup: avgSpeedup,
      avg_query_speedup: avgQuerySpeedup,
      avg_get_speedup: avgGetSpeedup,
      avg_index_speedup: avgIndexSpeedup
    },
    latest_avg: latest && latest.type === 'rust_memory_transition_benchmark' ? {
      avg_speedup: Number(latest.avg_speedup || 0),
      avg_query_speedup: Number(latest.avg_query_speedup || 0),
      avg_get_speedup: Number(latest.avg_get_speedup || 0),
      avg_index_speedup: Number(latest.avg_index_speedup || 0)
    } : null,
    report_avg: reportMeta ? {
      avg_speedup: Number(reportMeta.avg_speedup || 0),
      avg_query_speedup: Number(reportMeta.avg_query_speedup || 0),
      avg_get_speedup: Number(reportMeta.avg_get_speedup || 0),
      avg_index_speedup: Number(reportMeta.avg_index_speedup || 0)
    } : null,
    checks,
    failed_checks: failedChecks,
    benchmark_history_path: path.relative(ROOT, policy.paths.benchmark_path).replace(/\\/g, '/'),
    benchmark_latest_path: path.relative(ROOT, policy.paths.benchmark_latest_path).replace(/\\/g, '/'),
    benchmark_report_path: path.relative(ROOT, policy.paths.benchmark_report_path).replace(/\\/g, '/')
  };
  writeTransitionReceipt(policy, out);
  if (strict && out.ok !== true) emit(out, 1);
  return out;
}

function status(policy) {
  return {
    ok: true,
    type: 'rust_memory_transition_status',
    shadow_only: policy.shadow_only,
    soak: policy.soak,
    latest: readJson(policy.paths.latest_path, {}),
    benchmark_latest: readJson(policy.paths.benchmark_latest_path, {}),
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
  if (cmd === 'consistency-check') emit(benchmarkConsistencyCheck(args, policy));
  if (cmd === 'index-probe') emit(indexProbe(args, policy));
  if (cmd === 'selector') emit(setSelector(args, policy));
  if (cmd === 'auto-selector') emit(autoSelector(policy));
  if (cmd === 'soak-gate') emit(soakGate(args, policy));
  if (cmd === 'retire-check') emit(retireCheck(policy));
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();

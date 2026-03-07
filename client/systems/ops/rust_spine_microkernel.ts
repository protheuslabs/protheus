#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-034
 * Rust spine microkernel control-path extraction lane.
 */

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
  clampNumber,
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.RUST_SPINE_MICROKERNEL_POLICY_PATH
  ? path.resolve(process.env.RUST_SPINE_MICROKERNEL_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_spine_microkernel_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_spine_microkernel.js parity [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_spine_microkernel.js benchmark [--window=N] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_spine_microkernel.js cutover [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_spine_microkernel.js rollback [--reason=<text>] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_spine_microkernel.js route --component=<id> [--policy=<path>]');
  console.log('  node systems/ops/rust_spine_microkernel.js status [--policy=<path>]');
}

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, 280)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, 280)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_parity_pass_rate: 1,
      min_component_parity_streak: 2,
      max_p95_latency_ms: 600,
      max_p99_latency_ms: 1200,
      min_availability: 0.995
    },
    profiles: {
      initial: 'shadow_js',
      rust_spine: { rust_first: true, js_fallback: 'emergency_only' },
      emergency_js: { rust_first: false, js_fallback: 'allowed' },
      shadow_js: { rust_first: false, js_fallback: 'allowed' }
    },
    components: [
      {
        id: 'guard',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=guard', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=guard', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'spawn_broker',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spawn_broker', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spawn_broker', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'model_router',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=model_router', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=model_router', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'origin_lock',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=origin_lock', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=origin_lock', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'fractal_orchestrator',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=fractal_orchestrator', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=fractal_orchestrator', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      }
    ],
    paths: {
      state_path: 'state/ops/rust_spine_microkernel/state.json',
      latest_path: 'state/ops/rust_spine_microkernel/latest.json',
      receipts_path: 'state/ops/rust_spine_microkernel/receipts.jsonl',
      parity_history_path: 'state/ops/rust_spine_microkernel/parity_history.jsonl',
      benchmark_history_path: 'state/ops/rust_spine_microkernel/benchmark_history.jsonl',
      rollback_history_path: 'state/ops/rust_spine_microkernel/rollback_history.jsonl'
    }
  };
}

function normalizeCommand(v: unknown) {
  return normalizeList(v).filter(Boolean);
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const profiles = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const componentsRaw = Array.isArray(raw.components) ? raw.components : base.components;
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const components = componentsRaw
    .map((row: any) => ({
      id: normalizeToken(row && row.id || '', 80),
      js_command: normalizeCommand(row && row.js_command),
      rust_command: normalizeCommand(row && row.rust_command),
      contract_fields: normalizeList(row && row.contract_fields || ['type', 'component'])
        .map((field) => normalizeToken(field, 80))
        .filter(Boolean)
    }))
    .filter((row: any) => row.id && row.js_command.length > 0 && row.rust_command.length > 0);

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    thresholds: {
      min_parity_pass_rate: clampNumber(thresholds.min_parity_pass_rate, 0, 1, base.thresholds.min_parity_pass_rate),
      min_component_parity_streak: clampInt(thresholds.min_component_parity_streak, 1, 1000, base.thresholds.min_component_parity_streak),
      max_p95_latency_ms: clampNumber(thresholds.max_p95_latency_ms, 1, 60_000, base.thresholds.max_p95_latency_ms),
      max_p99_latency_ms: clampNumber(thresholds.max_p99_latency_ms, 1, 120_000, base.thresholds.max_p99_latency_ms),
      min_availability: clampNumber(thresholds.min_availability, 0, 1, base.thresholds.min_availability)
    },
    profiles: {
      initial: normalizeToken(profiles.initial || base.profiles.initial, 40) || base.profiles.initial,
      rust_spine: {
        rust_first: toBool(profiles.rust_spine && profiles.rust_spine.rust_first, true),
        js_fallback: normalizeToken(profiles.rust_spine && profiles.rust_spine.js_fallback || base.profiles.rust_spine.js_fallback, 40)
      },
      emergency_js: {
        rust_first: toBool(profiles.emergency_js && profiles.emergency_js.rust_first, false),
        js_fallback: normalizeToken(profiles.emergency_js && profiles.emergency_js.js_fallback || base.profiles.emergency_js.js_fallback, 40)
      },
      shadow_js: {
        rust_first: toBool(profiles.shadow_js && profiles.shadow_js.rust_first, false),
        js_fallback: normalizeToken(profiles.shadow_js && profiles.shadow_js.js_fallback || base.profiles.shadow_js.js_fallback, 40)
      }
    },
    components,
    paths: {
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      parity_history_path: resolvePath(paths.parity_history_path || base.paths.parity_history_path, base.paths.parity_history_path),
      benchmark_history_path: resolvePath(paths.benchmark_history_path || base.paths.benchmark_history_path, base.paths.benchmark_history_path),
      rollback_history_path: resolvePath(paths.rollback_history_path || base.paths.rollback_history_path, base.paths.rollback_history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: any) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'rust_spine_microkernel_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      active_profile: policy.profiles.initial || 'shadow_js',
      parity_runs: 0,
      benchmark_runs: 0,
      last_parity: null,
      last_benchmark: null,
      component_health: {}
    };
  }
  return {
    schema_id: 'rust_spine_microkernel_state',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    active_profile: normalizeToken(src.active_profile || policy.profiles.initial || 'shadow_js', 40) || 'shadow_js',
    parity_runs: Math.max(0, Number(src.parity_runs || 0)),
    benchmark_runs: Math.max(0, Number(src.benchmark_runs || 0)),
    last_parity: src.last_parity || null,
    last_benchmark: src.last_benchmark || null,
    component_health: src.component_health && typeof src.component_health === 'object' ? src.component_health : {}
  };
}

function saveState(policy: any, state: any) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'rust_spine_microkernel_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    active_profile: normalizeToken(state.active_profile || 'shadow_js', 40) || 'shadow_js',
    parity_runs: Math.max(0, Number(state.parity_runs || 0)),
    benchmark_runs: Math.max(0, Number(state.benchmark_runs || 0)),
    last_parity: state.last_parity || null,
    last_benchmark: state.last_benchmark || null,
    component_health: state.component_health && typeof state.component_health === 'object' ? state.component_health : {}
  });
}

function runCommandJson(command: string[], timeoutMs = 30_000) {
  const cmd = Array.isArray(command) ? command.slice(0) : [];
  if (cmd.length < 1) return { ok: false, code: 127, payload: null, stderr: 'missing_command', duration_ms: 0 };
  const started = Date.now();
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(proc.status || 0) === 0,
    code: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload: parseJsonFromStdout(proc.stdout),
    stderr: cleanText(proc.stderr || '', 600),
    duration_ms: Math.max(0, Date.now() - started)
  };
}

function contractMatch(fields: string[], jsPayload: any, rustPayload: any) {
  for (const field of fields) {
    const key = String(field || '').trim();
    if (!key) continue;
    if (JSON.stringify(jsPayload && jsPayload[key]) !== JSON.stringify(rustPayload && rustPayload[key])) return false;
  }
  return true;
}

function cmdParity(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const rows = [];
  for (const component of policy.components) {
    const js = runCommandJson(component.js_command);
    const rust = runCommandJson(component.rust_command);
    const parityPass = js.ok && rust.ok && contractMatch(component.contract_fields, js.payload, rust.payload);
    rows.push({
      component: component.id,
      js_ok: js.ok,
      rust_ok: rust.ok,
      parity_pass: parityPass,
      js_duration_ms: js.duration_ms,
      rust_duration_ms: rust.duration_ms,
      latency_delta_ms: Math.abs(Number(js.duration_ms || 0) - Number(rust.duration_ms || 0)),
      js_error: js.ok ? null : js.stderr,
      rust_error: rust.ok ? null : rust.stderr
    });
  }
  const total = rows.length;
  const passed = rows.filter((row) => row.parity_pass === true).length;
  const parityPassRate = total > 0 ? Number((passed / total).toFixed(6)) : 0;
  const out = {
    ok: true,
    type: 'rust_spine_microkernel_parity',
    ts: nowIso(),
    apply,
    component_count: total,
    parity_pass_count: passed,
    parity_pass_rate: parityPassRate,
    components: rows
  };
  if (apply) {
    appendJsonl(policy.paths.parity_history_path, out);
    const state = loadState(policy);
    state.parity_runs += 1;
    state.last_parity = {
      ts: out.ts,
      parity_pass_rate: parityPassRate
    };
    state.component_health = rows.reduce((acc: Record<string, any>, row: any) => {
      acc[row.component] = {
        parity_pass: row.parity_pass === true,
        rust_ok: row.rust_ok === true,
        js_ok: row.js_ok === true
      };
      return acc;
    }, {});
    saveState(policy, state);
  }
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out, 0);
}

function average(values: number[]) {
  if (!Array.isArray(values) || values.length < 1) return 0;
  return values.reduce((acc, n) => acc + Number(n || 0), 0) / values.length;
}

function percentile(values: number[], p: number) {
  if (!Array.isArray(values) || values.length < 1) return 0;
  const sorted = values.slice(0).map((n) => Number(n || 0)).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function cmdBenchmark(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const window = clampInt(args.window, 1, 5000, 30);
  const history = readJsonl(policy.paths.parity_history_path).slice(-window);
  const latencies = [];
  let totalChecks = 0;
  let passedChecks = 0;
  for (const row of history) {
    const components = Array.isArray(row && row.components) ? row.components : [];
    for (const comp of components) {
      totalChecks += 1;
      if (comp.parity_pass === true) passedChecks += 1;
      latencies.push(Number(comp.rust_duration_ms || 0));
    }
  }
  const p95 = Number(percentile(latencies, 95).toFixed(3));
  const p99 = Number(percentile(latencies, 99).toFixed(3));
  const availability = totalChecks > 0 ? Number((passedChecks / totalChecks).toFixed(6)) : 0;
  const bench = {
    ok: true,
    type: 'rust_spine_microkernel_benchmark',
    ts: nowIso(),
    apply,
    sample_rows: history.length,
    sample_checks: totalChecks,
    avg_latency_ms: Number(average(latencies).toFixed(3)),
    p95_latency_ms: p95,
    p99_latency_ms: p99,
    availability,
    slo_pass: (
      p95 <= Number(policy.thresholds.max_p95_latency_ms || 600)
      && p99 <= Number(policy.thresholds.max_p99_latency_ms || 1200)
      && availability >= Number(policy.thresholds.min_availability || 0.995)
    )
  };
  if (apply) {
    appendJsonl(policy.paths.benchmark_history_path, bench);
    const state = loadState(policy);
    state.benchmark_runs += 1;
    state.last_benchmark = {
      ts: bench.ts,
      p95_latency_ms: p95,
      p99_latency_ms: p99,
      availability: bench.availability,
      slo_pass: bench.slo_pass
    };
    saveState(policy, state);
  }
  writeJsonAtomic(policy.paths.latest_path, bench);
  appendJsonl(policy.paths.receipts_path, bench);
  emit(bench, 0);
}

function parityStreak(policy: any) {
  const history = readJsonl(policy.paths.parity_history_path).slice(-1000);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (Number(row && row.parity_pass_rate || 0) < Number(policy.thresholds.min_parity_pass_rate || 1)) break;
    streak += 1;
  }
  return streak;
}

function cmdCutover(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const state = loadState(policy);
  const lastParity = state.last_parity || {};
  const lastBenchmark = state.last_benchmark || {};
  const streak = parityStreak(policy);
  const ready = (
    Number(lastParity.parity_pass_rate || 0) >= Number(policy.thresholds.min_parity_pass_rate || 1)
    && streak >= Number(policy.thresholds.min_component_parity_streak || 2)
    && lastBenchmark.slo_pass === true
  );
  const nextProfile = ready ? 'rust_spine' : state.active_profile;
  if (apply && ready) {
    state.active_profile = nextProfile;
    saveState(policy, state);
  }
  const out = {
    ok: true,
    type: 'rust_spine_microkernel_cutover',
    ts: nowIso(),
    apply,
    ready,
    active_profile: apply && ready ? nextProfile : state.active_profile,
    parity_streak: streak,
    last_parity_pass_rate: Number(lastParity.parity_pass_rate || 0),
    last_slo_pass: lastBenchmark.slo_pass === true
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out, 0);
}

function cmdRollback(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const reason = cleanText(args.reason || 'manual_emergency_rollback', 220) || 'manual_emergency_rollback';
  const state = loadState(policy);
  const prev = state.active_profile;
  if (apply) {
    state.active_profile = 'emergency_js';
    saveState(policy, state);
  }
  const out = {
    ok: true,
    type: 'rust_spine_microkernel_rollback',
    ts: nowIso(),
    apply,
    previous_profile: prev,
    active_profile: apply ? 'emergency_js' : prev,
    reason
  };
  if (apply) appendJsonl(policy.paths.rollback_history_path, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out, 0);
}

function componentHealth(state: any, componentId: string) {
  const health = state.component_health && typeof state.component_health === 'object' ? state.component_health : {};
  return health[componentId] || {};
}

function cmdRoute(args: any, policy: any) {
  const component = normalizeToken(args.component || '', 80);
  if (!component) emit({ ok: false, error: 'component_required' }, 1);
  const state = loadState(policy);
  const profile = state.active_profile || 'shadow_js';
  const health = componentHealth(state, component);
  const profileCfg = policy.profiles[profile] || policy.profiles.shadow_js;

  let chosen = profileCfg && profileCfg.rust_first === true ? 'rust' : 'js';
  if (chosen === 'rust' && health.rust_ok !== true) {
    const fallbackMode = cleanText(profileCfg.js_fallback || '', 40);
    if (fallbackMode === 'allowed' || profile === 'emergency_js') chosen = 'js';
    else emit({
      ok: false,
      error: 'rust_unhealthy_emergency_profile_required',
      component,
      active_profile: profile
    }, 2);
  }

  emit({
    ok: true,
    type: 'rust_spine_microkernel_route',
    component,
    active_profile: profile,
    chosen_engine: chosen,
    component_health: health
  }, 0);
}

function cmdStatus(policy: any) {
  const state = loadState(policy);
  const parityHistory = readJsonl(policy.paths.parity_history_path);
  const benchmarkHistory = readJsonl(policy.paths.benchmark_history_path);
  const rollbackHistory = readJsonl(policy.paths.rollback_history_path);
  emit({
    ok: true,
    type: 'rust_spine_microkernel_status',
    state,
    parity_runs: parityHistory.length,
    benchmark_runs: benchmarkHistory.length,
    rollback_runs: rollbackHistory.length
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) emit({ ok: false, error: 'policy_disabled' }, 2);
  if (cmd === 'parity') return cmdParity(args, policy);
  if (cmd === 'benchmark') return cmdBenchmark(args, policy);
  if (cmd === 'cutover') return cmdCutover(args, policy);
  if (cmd === 'rollback') return cmdRollback(args, policy);
  if (cmd === 'route') return cmdRoute(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

main();

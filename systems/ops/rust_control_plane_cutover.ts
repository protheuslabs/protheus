#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-021
 *
 * Rust-first control-plane cutover orchestrator:
 * - parity harness across guard/spine_router/reflex_dispatcher/spawn_broker/actuation_executor
 * - benchmark/SLO gate evidence before default-profile cutover
 * - deterministic JS fallback only when emergency profile is active
 * - staged deprecation receipts for legacy JS hot paths
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
  clampNumber,
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.RUST_CONTROL_PLANE_CUTOVER_POLICY_PATH
  ? path.resolve(process.env.RUST_CONTROL_PLANE_CUTOVER_POLICY_PATH)
  : path.join(ROOT, 'config', 'rust_control_plane_cutover_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/rust_control_plane_cutover.js parity-harness [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_control_plane_cutover.js benchmark [--window=N] [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_control_plane_cutover.js activate --profile=default|emergency [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_control_plane_cutover.js route --component=<id> [--policy=<path>]');
  console.log('  node systems/ops/rust_control_plane_cutover.js deprecate --component=<id> [--apply=1|0] [--policy=<path>]');
  console.log('  node systems/ops/rust_control_plane_cutover.js status [--policy=<path>]');
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
  if (Array.isArray(v)) return v.map((row) => cleanText(row, 320)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, 320)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    thresholds: {
      min_parity_pass_rate: 1,
      max_avg_latency_delta_ms: 500,
      min_stable_parity_runs: 3
    },
    profiles: {
      initial: 'emergency',
      default: {
        rust_first: true,
        js_fallback: 'emergency_only'
      },
      emergency: {
        rust_first: false,
        js_fallback: 'allowed'
      }
    },
    components: [
      {
        id: 'guard',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=guard', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=guard', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'spine_router',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spine_router', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spine_router', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'reflex_dispatcher',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=reflex_dispatcher', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=reflex_dispatcher', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'spawn_broker',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spawn_broker', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=spawn_broker', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      },
      {
        id: 'actuation_executor',
        js_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=actuation_executor', '--engine=js'],
        rust_command: ['node', 'systems/rust/control_plane_component_shim.js', 'run', '--component=actuation_executor', '--engine=rust'],
        contract_fields: ['type', 'component', 'contract_version']
      }
    ],
    paths: {
      state_path: 'state/ops/rust_control_plane_cutover/state.json',
      latest_path: 'state/ops/rust_control_plane_cutover/latest.json',
      receipts_path: 'state/ops/rust_control_plane_cutover/receipts.jsonl',
      parity_history_path: 'state/ops/rust_control_plane_cutover/parity_history.jsonl',
      benchmark_history_path: 'state/ops/rust_control_plane_cutover/benchmark_history.jsonl',
      deprecations_path: 'state/ops/rust_control_plane_cutover/deprecations.json'
    }
  };
}

function normalizeCommand(cmd: unknown) {
  const arr = Array.isArray(cmd) ? cmd : normalizeList(cmd);
  return arr.map((row: any) => cleanText(row, 320)).filter(Boolean);
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
      min_parity_pass_rate: clampNumber(
        thresholds.min_parity_pass_rate,
        0,
        1,
        base.thresholds.min_parity_pass_rate
      ),
      max_avg_latency_delta_ms: clampNumber(
        thresholds.max_avg_latency_delta_ms,
        1,
        120000,
        base.thresholds.max_avg_latency_delta_ms
      ),
      min_stable_parity_runs: clampInt(
        thresholds.min_stable_parity_runs,
        1,
        10000,
        base.thresholds.min_stable_parity_runs
      )
    },
    profiles: {
      initial: normalizeToken(profiles.initial || base.profiles.initial, 32) || base.profiles.initial,
      default: {
        rust_first: toBool(
          profiles.default && profiles.default.rust_first,
          base.profiles.default.rust_first
        ),
        js_fallback: normalizeToken(
          profiles.default && profiles.default.js_fallback || base.profiles.default.js_fallback,
          40
        ) || base.profiles.default.js_fallback
      },
      emergency: {
        rust_first: toBool(
          profiles.emergency && profiles.emergency.rust_first,
          base.profiles.emergency.rust_first
        ),
        js_fallback: normalizeToken(
          profiles.emergency && profiles.emergency.js_fallback || base.profiles.emergency.js_fallback,
          40
        ) || base.profiles.emergency.js_fallback
      }
    },
    components,
    paths: {
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      parity_history_path: resolvePath(paths.parity_history_path || base.paths.parity_history_path, base.paths.parity_history_path),
      benchmark_history_path: resolvePath(paths.benchmark_history_path || base.paths.benchmark_history_path, base.paths.benchmark_history_path),
      deprecations_path: resolvePath(paths.deprecations_path || base.paths.deprecations_path, base.paths.deprecations_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy: any) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'rust_control_plane_cutover_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      active_profile: policy.profiles.initial || 'emergency',
      parity_runs: 0,
      benchmark_runs: 0,
      last_parity: null,
      last_benchmark: null
    };
  }
  return {
    schema_id: 'rust_control_plane_cutover_state',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    active_profile: normalizeToken(src.active_profile || policy.profiles.initial || 'emergency', 32) || 'emergency',
    parity_runs: Math.max(0, Number(src.parity_runs || 0)),
    benchmark_runs: Math.max(0, Number(src.benchmark_runs || 0)),
    last_parity: src.last_parity && typeof src.last_parity === 'object' ? src.last_parity : null,
    last_benchmark: src.last_benchmark && typeof src.last_benchmark === 'object' ? src.last_benchmark : null
  };
}

function saveState(policy: any, state: any) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'rust_control_plane_cutover_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    active_profile: normalizeToken(state.active_profile || 'emergency', 32) || 'emergency',
    parity_runs: Math.max(0, Number(state.parity_runs || 0)),
    benchmark_runs: Math.max(0, Number(state.benchmark_runs || 0)),
    last_parity: state.last_parity || null,
    last_benchmark: state.last_benchmark || null
  });
}

function runCommandJson(command: string[], timeoutMs = 30000) {
  const cmd = Array.isArray(command) ? command.slice(0) : [];
  if (cmd.length < 1) return { ok: false, code: 127, payload: null, stderr: 'command_missing', duration_ms: 0 };
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
    stderr: cleanText(proc.stderr || '', 800),
    duration_ms: Math.max(0, Date.now() - started)
  };
}

function contractMatch(fields: string[], jsPayload: any, rustPayload: any) {
  for (const field of fields) {
    const key = String(field || '').trim();
    if (!key) continue;
    const a = jsPayload ? jsPayload[key] : undefined;
    const b = rustPayload ? rustPayload[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

function parityHealthByComponent(policy: any, parityRow: any) {
  const out: Record<string, any> = {};
  const rows = parityRow && Array.isArray(parityRow.components) ? parityRow.components : [];
  for (const component of policy.components) {
    const hit = rows.find((row: any) => String(row.component || '') === String(component.id || ''));
    out[component.id] = {
      parity_pass: !!(hit && hit.parity_pass === true),
      rust_ok: !!(hit && hit.rust_ok === true),
      js_ok: !!(hit && hit.js_ok === true),
      latency_delta_ms: hit ? Number(hit.latency_delta_ms || 0) : null
    };
  }
  return out;
}

function cmdParityHarness(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const rows = [];
  for (const component of policy.components) {
    const js = runCommandJson(component.js_command, 30000);
    const rust = runCommandJson(component.rust_command, 30000);
    const parityPass = js.ok
      && rust.ok
      && contractMatch(component.contract_fields, js.payload, rust.payload);
    rows.push({
      component: component.id,
      js_ok: js.ok,
      rust_ok: rust.ok,
      parity_pass: parityPass,
      contract_fields: component.contract_fields,
      js_code: js.code,
      rust_code: rust.code,
      js_duration_ms: js.duration_ms,
      rust_duration_ms: rust.duration_ms,
      latency_delta_ms: Math.abs(Number(js.duration_ms || 0) - Number(rust.duration_ms || 0)),
      js_error: js.ok ? null : js.stderr,
      rust_error: rust.ok ? null : rust.stderr
    });
  }

  const total = rows.length;
  const passed = rows.filter((row) => row.parity_pass === true).length;
  const passRate = total > 0 ? Number((passed / total).toFixed(6)) : 0;
  const avgLatencyDelta = rows.length > 0
    ? Number((rows.reduce((acc, row) => acc + Number(row.latency_delta_ms || 0), 0) / rows.length).toFixed(3))
    : null;

  const out = {
    ok: true,
    type: 'rust_control_plane_parity_harness',
    ts: nowIso(),
    apply,
    component_count: total,
    parity_pass_count: passed,
    parity_pass_rate: passRate,
    avg_latency_delta_ms: avgLatencyDelta,
    components: rows
  };
  if (apply) appendJsonl(policy.paths.parity_history_path, out);

  const state = loadState(policy);
  if (apply) {
    state.parity_runs += 1;
    state.last_parity = {
      ts: out.ts,
      parity_pass_rate: out.parity_pass_rate,
      avg_latency_delta_ms: out.avg_latency_delta_ms,
      component_health: parityHealthByComponent(policy, out)
    };
    saveState(policy, state);
  }
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function stableParityRuns(policy: any, benchmarkRows: any[]) {
  let streak = 0;
  for (let i = benchmarkRows.length - 1; i >= 0; i -= 1) {
    const row = benchmarkRows[i];
    if (row && row.slo_pass === true) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

function cmdBenchmark(args: any, policy: any) {
  const apply = toBool(args.apply, true);
  const window = clampInt(args.window, 1, 1000, 20);
  const history = readJsonl(policy.paths.parity_history_path);
  const recent = history.slice(-window);
  const probes = [];
  for (const row of recent) {
    const components = row && Array.isArray(row.components) ? row.components : [];
    probes.push(...components);
  }
  const totalProbes = probes.length;
  const passProbes = probes.filter((row: any) => row.parity_pass === true).length;
  const passRate = totalProbes > 0 ? Number((passProbes / totalProbes).toFixed(6)) : 0;
  const avgLatencyDelta = totalProbes > 0
    ? Number((probes.reduce((acc: number, row: any) => acc + Number(row.latency_delta_ms || 0), 0) / totalProbes).toFixed(3))
    : null;
  const latencyScore = avgLatencyDelta == null
    ? 0
    : Math.max(0, Math.min(1, Number(policy.thresholds.max_avg_latency_delta_ms || 1) / Math.max(1, Number(avgLatencyDelta))));
  const score = Number((passRate * 0.7 + latencyScore * 0.3).toFixed(6));
  const sloPass = passRate >= Number(policy.thresholds.min_parity_pass_rate || 0)
    && avgLatencyDelta != null
    && avgLatencyDelta <= Number(policy.thresholds.max_avg_latency_delta_ms || 0);

  const out = {
    ok: true,
    type: 'rust_control_plane_benchmark',
    ts: nowIso(),
    apply,
    window,
    total_probes: totalProbes,
    pass_probes: passProbes,
    parity_pass_rate: passRate,
    avg_latency_delta_ms: avgLatencyDelta,
    score,
    thresholds: {
      min_parity_pass_rate: policy.thresholds.min_parity_pass_rate,
      max_avg_latency_delta_ms: policy.thresholds.max_avg_latency_delta_ms,
      min_stable_parity_runs: policy.thresholds.min_stable_parity_runs
    },
    stable_runs: 0,
    slo_pass: sloPass
  };

  if (apply) appendJsonl(policy.paths.benchmark_history_path, out);
  const benchHistory = readJsonl(policy.paths.benchmark_history_path);
  out.stable_runs = stableParityRuns(policy, benchHistory);

  const state = loadState(policy);
  if (apply) {
    state.benchmark_runs += 1;
    state.last_benchmark = {
      ts: out.ts,
      parity_pass_rate: out.parity_pass_rate,
      avg_latency_delta_ms: out.avg_latency_delta_ms,
      score: out.score,
      stable_runs: out.stable_runs,
      slo_pass: out.slo_pass
    };
    saveState(policy, state);
  }
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  emit(out);
}

function cmdActivate(args: any, policy: any) {
  const profile = normalizeToken(args.profile || '', 32);
  if (!['default', 'emergency'].includes(profile)) {
    emit({ ok: false, type: 'rust_control_plane_activate', error: 'profile_required_default_or_emergency' }, 1);
  }
  const apply = toBool(args.apply, true);
  const state = loadState(policy);
  const benchmark = state.last_benchmark || null;

  const reasons = [];
  if (profile === 'default') {
    if (!benchmark || benchmark.slo_pass !== true) reasons.push('benchmark_slo_not_passed');
    if (!benchmark || Number(benchmark.stable_runs || 0) < Number(policy.thresholds.min_stable_parity_runs || 0)) {
      reasons.push('stable_parity_runs_below_threshold');
    }
  }

  const ok = reasons.length === 0;
  if (apply && ok) {
    state.active_profile = profile;
    saveState(policy, state);
  }

  const out = {
    ok,
    type: 'rust_control_plane_activate',
    ts: nowIso(),
    apply,
    requested_profile: profile,
    active_profile: ok && apply ? profile : state.active_profile,
    reasons,
    benchmark: benchmark || null
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  if (!ok) emit(out, 1);
  emit(out);
}

function cmdRoute(args: any, policy: any) {
  const component = normalizeToken(args.component || '', 80);
  if (!component) emit({ ok: false, type: 'rust_control_plane_route', error: 'component_required' }, 1);
  const state = loadState(policy);
  const profile = state.active_profile === 'default' ? policy.profiles.default : policy.profiles.emergency;
  const parity = state.last_parity && state.last_parity.component_health ? state.last_parity.component_health : {};
  const health = parity[component] || { rust_ok: false, js_ok: false, parity_pass: false };

  let chosenEngine = null;
  let reason = null;
  let blocked = false;

  if (state.active_profile === 'default') {
    if (profile.rust_first === true && health.rust_ok === true) {
      chosenEngine = 'rust';
      reason = 'rust_first_profile';
    } else if (profile.js_fallback === 'allowed') {
      chosenEngine = 'js';
      reason = 'default_profile_js_fallback_allowed';
    } else {
      blocked = true;
      reason = 'rust_unhealthy_emergency_profile_required';
    }
  } else {
    chosenEngine = 'js';
    reason = 'emergency_profile_js_fallback';
  }

  emit({
    ok: blocked !== true,
    type: 'rust_control_plane_route',
    ts: nowIso(),
    component,
    active_profile: state.active_profile,
    chosen_engine: chosenEngine,
    blocked,
    reason,
    health
  }, blocked ? 1 : 0);
}

function cmdDeprecate(args: any, policy: any) {
  const component = normalizeToken(args.component || '', 80);
  if (!component) emit({ ok: false, type: 'rust_control_plane_deprecate', error: 'component_required' }, 1);
  const apply = toBool(args.apply, true);
  const state = loadState(policy);
  const benchmark = state.last_benchmark || null;

  const reasons = [];
  if (state.active_profile !== 'default') reasons.push('default_profile_required');
  if (!benchmark || benchmark.slo_pass !== true) reasons.push('benchmark_slo_not_passed');
  if (!benchmark || Number(benchmark.stable_runs || 0) < Number(policy.thresholds.min_stable_parity_runs || 0)) {
    reasons.push('stable_parity_runs_below_threshold');
  }
  const ok = reasons.length === 0;

  const deprecations = readJson(policy.paths.deprecations_path, {
    schema_id: 'rust_control_plane_deprecations',
    schema_version: '1.0',
    components: {}
  });
  if (!deprecations.components || typeof deprecations.components !== 'object') deprecations.components = {};
  if (apply && ok) {
    deprecations.components[component] = {
      deprecated_at: nowIso(),
      reason: 'rust_first_stable_parity_deprecation'
    };
    writeJsonAtomic(policy.paths.deprecations_path, deprecations);
  }

  const out = {
    ok,
    type: 'rust_control_plane_deprecate',
    ts: nowIso(),
    apply,
    component,
    reasons,
    deprecated: !!(ok && apply),
    deprecations_path: path.relative(ROOT, policy.paths.deprecations_path).replace(/\\/g, '/')
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  if (!ok) emit(out, 1);
  emit(out);
}

function cmdStatus(policy: any) {
  const state = loadState(policy);
  emit({
    ok: true,
    type: 'rust_control_plane_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only,
      thresholds: policy.thresholds,
      component_count: policy.components.length,
      active_profile: state.active_profile
    },
    state,
    latest: readJson(policy.paths.latest_path, null),
    deprecations: readJson(policy.paths.deprecations_path, null),
    paths: {
      state_path: path.relative(ROOT, policy.paths.state_path).replace(/\\/g, '/'),
      parity_history_path: path.relative(ROOT, policy.paths.parity_history_path).replace(/\\/g, '/'),
      benchmark_history_path: path.relative(ROOT, policy.paths.benchmark_history_path).replace(/\\/g, '/'),
      receipts_path: path.relative(ROOT, policy.paths.receipts_path).replace(/\\/g, '/')
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'rust_control_plane_cutover_disabled' }, 1);

  if (cmd === 'parity-harness') return cmdParityHarness(args, policy);
  if (cmd === 'benchmark') return cmdBenchmark(args, policy);
  if (cmd === 'activate') return cmdActivate(args, policy);
  if (cmd === 'route') return cmdRoute(args, policy);
  if (cmd === 'deprecate') return cmdDeprecate(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  process.exit(1);
}

main();

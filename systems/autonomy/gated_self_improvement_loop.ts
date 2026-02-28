#!/usr/bin/env node
'use strict';
export {};

/**
 * gated_self_improvement_loop.js
 *
 * V3-038: governed autonomous self-improvement loop.
 *
 * Usage:
 *   node systems/autonomy/gated_self_improvement_loop.js propose --objective-id=<id> --target-path=<path> [--summary=...] [--risk=low|medium|high]
 *   node systems/autonomy/gated_self_improvement_loop.js run --proposal-id=<id> [--apply=1|0] [--approval-a=<id>] [--approval-b=<id>] [--days=N]
 *   node systems/autonomy/gated_self_improvement_loop.js rollback --proposal-id=<id> [--reason=...]
 *   node systems/autonomy/gated_self_improvement_loop.js status [--proposal-id=<id>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadDynamicBurnOracleSignal } = require('../../lib/dynamic_burn_budget_signal');
const {
  loadSymbiosisCoherenceSignal,
  evaluateRecursionRequest
} = require('../../lib/symbiosis_coherence_signal');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.GATED_SELF_IMPROVEMENT_POLICY_PATH
  ? path.resolve(process.env.GATED_SELF_IMPROVEMENT_POLICY_PATH)
  : path.join(ROOT, 'config', 'gated_self_improvement_policy.json');
const GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH = process.env.GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH
  ? path.resolve(process.env.GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH)
  : path.join(ROOT, 'state', 'ops', 'dynamic_burn_budget_oracle', 'latest.json');
const SELF_CODE_EVOLUTION_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'self_code_evolution_sandbox.js');
const AUTONOMY_SIMULATION_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'autonomy_simulation_harness.js');
const RED_TEAM_HARNESS_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'red_team_harness.js');
let stateKernelDualWriteMod: AnyObj = null;
try {
  stateKernelDualWriteMod = require('../ops/state_kernel_dual_write.js');
} catch {
  stateKernelDualWriteMod = null;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackAbs: string) {
  const text = cleanText(raw, 420);
  if (!text) return fallbackAbs;
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function stableId(seed: string, prefix: string) {
  return `${prefix}_${crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 12)}`;
}

function parseJsonMaybe(v: unknown) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function parseRecursionRequest(args: AnyObj) {
  const depthRaw = args['recursion-depth'] != null
    ? args['recursion-depth']
    : (args.recursion_depth != null ? args.recursion_depth : null);
  const unboundedRaw = args['recursion-unbounded'] != null
    ? args['recursion-unbounded']
    : (args.recursion_unbounded != null ? args.recursion_unbounded : null);
  const depthToken = normalizeToken(depthRaw, 40);
  const unboundedByDepth = ['unbounded', 'infinite', 'max', 'none'].includes(depthToken);
  const depthNumber = Number(depthRaw);
  return {
    requested_depth: unboundedByDepth
      ? 'unbounded'
      : (Number.isFinite(depthNumber) ? clampInt(depthNumber, 1, 1_000_000_000, 1) : 1),
    requested_unbounded: unboundedByDepth || toBool(unboundedRaw, false)
  };
}

function normalizeBurnPressure(v: unknown) {
  const raw = normalizeToken(v || 'none', 32);
  if (raw === 'critical') return 'critical';
  if (raw === 'high') return 'high';
  if (raw === 'medium') return 'medium';
  if (raw === 'low') return 'low';
  return 'none';
}

function loadSelfImprovementBurnOracle() {
  const signal = loadDynamicBurnOracleSignal({
    latest_path: GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH
  });
  const payload = signal && signal.payload && typeof signal.payload === 'object'
    ? signal.payload
    : {};
  const decisions = payload && payload.decisions && typeof payload.decisions === 'object'
    ? payload.decisions
    : {};
  return {
    available: signal && signal.available === true,
    pressure: normalizeBurnPressure(signal && signal.pressure),
    hold: decisions.self_improvement_hold === true,
    projected_runway_days: signal && signal.projected_runway_days != null
      ? Number(signal.projected_runway_days)
      : null,
    projected_days_to_reset: signal && signal.projected_days_to_reset != null
      ? Number(signal.projected_days_to_reset)
      : null,
    reason_codes: Array.isArray(signal && signal.reason_codes) ? signal.reason_codes.slice(0, 12) : [],
    source_path: signal && signal.latest_path_rel
      ? signal.latest_path_rel
      : rel(GATED_SELF_IMPROVEMENT_BURN_ORACLE_LATEST_PATH)
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    require_objective_id: true,
    auto_rollback_on_regression: true,
    simulation_days: 180,
    rollout_stages: ['shadow', 'canary', 'live'],
    gates: {
      max_effective_drift_rate: 0.04,
      min_effective_yield_rate: 0.6,
      max_effective_safety_stop_rate: 0.01,
      max_red_critical_fail_cases: 0,
      max_red_fail_rate: 0.25
    },
    symbiosis_recursion_gate: {
      enabled: true,
      shadow_only: true,
      signal_policy_path: 'config/symbiosis_coherence_policy.json'
    },
    paths: {
      state_path: 'state/autonomy/gated_self_improvement/state.json',
      receipts_path: 'state/autonomy/gated_self_improvement/receipts.jsonl',
      latest_path: 'state/autonomy/gated_self_improvement/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const gates = raw.gates && typeof raw.gates === 'object' ? raw.gates : {};
  const symbiosisGate = raw.symbiosis_recursion_gate && typeof raw.symbiosis_recursion_gate === 'object'
    ? raw.symbiosis_recursion_gate
    : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    require_objective_id: raw.require_objective_id !== false,
    auto_rollback_on_regression: raw.auto_rollback_on_regression !== false,
    simulation_days: clampInt(raw.simulation_days, 14, 3650, base.simulation_days),
    rollout_stages: Array.from(new Set(
      (Array.isArray(raw.rollout_stages) ? raw.rollout_stages : base.rollout_stages)
        .map((v: unknown) => normalizeToken(v, 40))
        .filter(Boolean)
    )),
    gates: {
      max_effective_drift_rate: clampNumber(gates.max_effective_drift_rate, 0, 1, base.gates.max_effective_drift_rate),
      min_effective_yield_rate: clampNumber(gates.min_effective_yield_rate, 0, 1, base.gates.min_effective_yield_rate),
      max_effective_safety_stop_rate: clampNumber(gates.max_effective_safety_stop_rate, 0, 1, base.gates.max_effective_safety_stop_rate),
      max_red_critical_fail_cases: clampInt(gates.max_red_critical_fail_cases, 0, 1000000, base.gates.max_red_critical_fail_cases),
      max_red_fail_rate: clampNumber(gates.max_red_fail_rate, 0, 1, base.gates.max_red_fail_rate)
    },
    symbiosis_recursion_gate: {
      enabled: !(symbiosisGate.enabled === false),
      shadow_only: symbiosisGate.shadow_only != null
        ? toBool(symbiosisGate.shadow_only, true)
        : base.symbiosis_recursion_gate.shadow_only === true,
      signal_policy_path: cleanText(
        symbiosisGate.signal_policy_path || base.symbiosis_recursion_gate.signal_policy_path,
        260
      ) || base.symbiosis_recursion_gate.signal_policy_path
    },
    paths: {
      state_path: resolvePath(paths.state_path, path.join(ROOT, base.paths.state_path)),
      receipts_path: resolvePath(paths.receipts_path, path.join(ROOT, base.paths.receipts_path)),
      latest_path: resolvePath(paths.latest_path, path.join(ROOT, base.paths.latest_path))
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'gated_self_improvement_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    proposals: {}
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'gated_self_improvement_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60),
    proposals: src.proposals && typeof src.proposals === 'object' ? src.proposals : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  const next = {
    schema_id: 'gated_self_improvement_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    proposals: state && state.proposals && typeof state.proposals === 'object' ? state.proposals : {}
  };
  writeJsonAtomic(policy.paths.state_path, next);
  if (stateKernelDualWriteMod && typeof stateKernelDualWriteMod.writeMirror === 'function') {
    try {
      stateKernelDualWriteMod.writeMirror({
        'organ-id': 'gated_self_improvement',
        'fs-path': policy.paths.state_path,
        'payload-json': JSON.stringify(next)
      });
    } catch {
      // Dual-write mirrors are best effort and must not block autonomy loops.
    }
  }
}

function currentStageIndex(row: AnyObj, policy: AnyObj) {
  const stages = Array.isArray(policy.rollout_stages) && policy.rollout_stages.length > 0
    ? policy.rollout_stages
    : ['shadow', 'canary', 'live'];
  const stage = normalizeToken(row.stage || 'shadow', 40) || 'shadow';
  const idx = stages.indexOf(stage);
  return {
    stage,
    idx: idx >= 0 ? idx : 0,
    stages
  };
}

function nextStage(row: AnyObj, policy: AnyObj) {
  const meta = currentStageIndex(row, policy);
  const nextIdx = Math.min(meta.idx + 1, meta.stages.length - 1);
  return meta.stages[nextIdx];
}

function extractSimulationMetrics(simPayload: AnyObj = {}) {
  const eff = simPayload && simPayload.checks_effective && typeof simPayload.checks_effective === 'object'
    ? simPayload.checks_effective
    : {};
  return {
    effective_drift_rate: Number(eff.drift_rate && eff.drift_rate.value),
    effective_yield_rate: Number(eff.yield_rate && eff.yield_rate.value),
    effective_safety_stop_rate: Number(eff.safety_stop_rate && eff.safety_stop_rate.value)
  };
}

function evaluateGates(policy: AnyObj, simMetrics: AnyObj = {}, redSummary: AnyObj = {}) {
  const drift = Number(simMetrics.effective_drift_rate);
  const yieldRate = Number(simMetrics.effective_yield_rate);
  const safetyStop = Number(simMetrics.effective_safety_stop_rate);
  const executedCases = Math.max(0, Number(redSummary.executed_cases || 0));
  const failCases = Math.max(0, Number(redSummary.fail_cases || 0));
  const criticalFailCases = Math.max(0, Number(redSummary.critical_fail_cases || 0));
  const failRate = executedCases > 0 ? failCases / executedCases : 0;
  const gates = {
    drift_ok: Number.isFinite(drift) && drift <= policy.gates.max_effective_drift_rate,
    yield_ok: Number.isFinite(yieldRate) && yieldRate >= policy.gates.min_effective_yield_rate,
    safety_ok: Number.isFinite(safetyStop) && safetyStop <= policy.gates.max_effective_safety_stop_rate,
    red_critical_ok: criticalFailCases <= policy.gates.max_red_critical_fail_cases,
    red_fail_rate_ok: failRate <= policy.gates.max_red_fail_rate
  };
  const pass = Object.values(gates).every((v) => v === true);
  return {
    pass,
    gates,
    red_fail_rate: Number(failRate.toFixed(6))
  };
}

function runNodeJson(script: string, args: string[], fallbackType: string) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const lines = stdout.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          payload = JSON.parse(lines[i]);
          break;
        } catch {}
      }
    }
  }
  return {
    ok: r.status === 0,
    code: Number(r.status || 0),
    type: fallbackType,
    payload,
    stdout,
    stderr
  };
}

function persistLatest(policy: AnyObj, out: AnyObj) {
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  if (stateKernelDualWriteMod && typeof stateKernelDualWriteMod.enqueueMirror === 'function') {
    try {
      stateKernelDualWriteMod.enqueueMirror({
        'queue-name': 'gated_self_improvement_receipts',
        'payload-json': JSON.stringify(out)
      });
    } catch {
      // queue mirror is intentionally non-blocking.
    }
  }
}

function cmdPropose(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    const out = { ok: false, type: 'gated_self_improvement_propose', error: 'loop_disabled' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 160);
  if (policy.require_objective_id && !objectiveId) {
    const out = { ok: false, type: 'gated_self_improvement_propose', error: 'objective_id_required' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const targetPath = cleanText(args['target-path'] || args.target_path || '', 240);
  if (!targetPath) {
    const out = { ok: false, type: 'gated_self_improvement_propose', error: 'target_path_required' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const recursionRequest = parseRecursionRequest(args);
  let symbiosisGate: AnyObj = {
    evaluated: false
  };
  if (policy.symbiosis_recursion_gate && policy.symbiosis_recursion_gate.enabled === true) {
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: policy.symbiosis_recursion_gate.signal_policy_path,
      refresh: true,
      persist: true
    });
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: recursionRequest.requested_depth,
      require_unbounded: recursionRequest.requested_unbounded,
      shadow_only_override: policy.symbiosis_recursion_gate.shadow_only === true
    });
    symbiosisGate = {
      evaluated: true,
      request: recursionRequest,
      ...gate
    };
    if (gate.blocked_hard === true) {
      const blocked = {
        ok: false,
        type: 'gated_self_improvement_propose',
        ts: nowIso(),
        error: 'symbiosis_recursion_gate_blocked',
        objective_id: objectiveId || null,
        target_path: targetPath,
        symbiosis_recursion_gate: symbiosisGate
      };
      persistLatest(policy, blocked);
      process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
      process.exit(1);
      return;
    }
  }
  const state = loadState(policy);
  const ts = nowIso();
  const proposalId = normalizeToken(
    args['proposal-id'] || args.proposal_id || stableId(`${objectiveId}|${targetPath}|${ts}`, 'gsi'),
    120
  );
  const row = {
    proposal_id: proposalId,
    objective_id: objectiveId || null,
    target_path: targetPath,
    summary: cleanText(args.summary || 'autonomous_self_improvement_candidate', 280),
    risk: normalizeToken(args.risk || 'medium', 40) || 'medium',
    recursion_depth_requested: recursionRequest.requested_depth,
    recursion_unbounded_requested: recursionRequest.requested_unbounded === true,
    created_at: ts,
    stage: 'shadow',
    status: 'proposed',
    sandbox_id: null,
    history: [],
    rollback_receipts: [],
    symbiosis_recursion_gate: symbiosisGate
  };
  state.proposals[proposalId] = row;
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'gated_self_improvement_propose',
    ts,
    proposal: row,
    symbiosis_recursion_gate: symbiosisGate,
    paths: {
      state_path: rel(policy.paths.state_path),
      receipts_path: rel(policy.paths.receipts_path)
    }
  };
  persistLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120);
  const row = proposalId ? state.proposals[proposalId] : null;
  if (!row) {
    const out = { ok: false, type: 'gated_self_improvement_run', error: 'proposal_not_found', proposal_id: proposalId || null };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }

  const ts = nowIso();
  const applyRequested = toBool(args.apply, false);
  const forceBudget = toBool(args['force-budget'] || args.force_budget, false);
  const burnOracle = loadSelfImprovementBurnOracle();
  if (burnOracle.available === true && burnOracle.hold === true && !forceBudget) {
    const out = {
      ok: false,
      type: 'gated_self_improvement_run',
      ts,
      proposal_id: proposalId,
      error: 'budget_oracle_hold',
      budget_oracle: burnOracle
    };
    persistLatest(policy, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  let symbiosisGate: AnyObj = {
    evaluated: false
  };
  if (policy.symbiosis_recursion_gate && policy.symbiosis_recursion_gate.enabled === true) {
    const requestedDepth = row.recursion_depth_requested != null
      ? row.recursion_depth_requested
      : 1;
    const requestedUnbounded = row.recursion_unbounded_requested === true;
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: policy.symbiosis_recursion_gate.signal_policy_path,
      refresh: true,
      persist: true
    });
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: requestedDepth,
      require_unbounded: requestedUnbounded,
      shadow_only_override: policy.symbiosis_recursion_gate.shadow_only === true
    });
    symbiosisGate = {
      evaluated: true,
      request: {
        requested_depth: requestedDepth,
        requested_unbounded: requestedUnbounded
      },
      ...gate
    };
    if (gate.blocked_hard === true) {
      const out = {
        ok: false,
        type: 'gated_self_improvement_run',
        ts,
        proposal_id: proposalId,
        error: 'symbiosis_recursion_gate_blocked',
        symbiosis_recursion_gate: symbiosisGate
      };
      persistLatest(policy, out);
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      process.exit(1);
      return;
    }
  }
  const sandboxApplyAllowed = applyRequested && !policy.shadow_only;
  const mockMode = toBool(args['mock-sandbox'] || args.mock_sandbox, false);

  const simulationMock = parseJsonMaybe(args['simulation-json'] || args.simulation_json);
  const simRun = simulationMock && typeof simulationMock === 'object'
    ? { ok: true, code: 0, type: 'simulation_mock', payload: simulationMock, stdout: '', stderr: '' }
    : runNodeJson(
      AUTONOMY_SIMULATION_SCRIPT,
      ['run', nowIso().slice(0, 10), `--days=${clampInt(args.days, 14, 3650, policy.simulation_days)}`, '--write=0'],
      'autonomy_simulation_harness'
    );

  const redMock = parseJsonMaybe(args['redteam-json'] || args.redteam_json);
  const redRun = redMock && typeof redMock === 'object'
    ? { ok: true, code: 0, type: 'redteam_mock', payload: redMock, stdout: '', stderr: '' }
    : runNodeJson(
      RED_TEAM_HARNESS_SCRIPT,
      ['run', nowIso().slice(0, 10), '--strict=1'],
      'red_team_harness'
    );

  const simMetrics = extractSimulationMetrics(simRun.payload || {});
  const redSummary = redRun.payload && redRun.payload.summary && typeof redRun.payload.summary === 'object'
    ? redRun.payload.summary
    : {};
  const gateEval = evaluateGates(policy, simMetrics, redSummary);

  let transition = 'hold';
  let rollback = null;
  if (gateEval.pass) {
    const next = nextStage(row, policy);
    if (next !== row.stage) {
      transition = `${row.stage}_to_${next}`;
      row.stage = next;
    } else {
      transition = 'steady_live';
    }
    row.status = row.stage === 'live' ? 'live_ready' : 'gated_pass';
  } else {
    row.status = 'gated_hold';
    if (policy.auto_rollback_on_regression && row.sandbox_id) {
      const rollbackMock = parseJsonMaybe(args['rollback-json'] || args.rollback_json);
      const rollbackRun = rollbackMock && typeof rollbackMock === 'object'
        ? { ok: true, payload: rollbackMock }
        : (mockMode
          ? { ok: true, payload: { ok: true, type: 'self_code_evolution_rollback', record: { rollback: { rollback_receipt_id: stableId(`${proposalId}|${ts}`, 'rb') } } } }
          : runNodeJson(
            SELF_CODE_EVOLUTION_SCRIPT,
            ['rollback', `--sandbox-id=${row.sandbox_id}`, `--reason=auto_regression_${proposalId}`],
            'self_code_evolution_rollback'
          ));
      rollback = {
        ok: rollbackRun.ok === true,
        receipt_id: cleanText(
          rollbackRun
          && rollbackRun.payload
          && rollbackRun.payload.record
          && rollbackRun.payload.record.rollback
          && rollbackRun.payload.record.rollback.rollback_receipt_id,
          120
        ) || stableId(`${proposalId}|${ts}|fallback`, 'rb')
      };
      row.rollback_receipts.push({
        ts,
        reason: 'regression_detected',
        receipt_id: rollback.receipt_id
      });
      row.status = rollback.ok ? 'rolled_back' : 'rollback_failed';
      transition = 'regression_auto_rollback';
    }
  }

  let sandboxOps: AnyObj = { proposed: false, tested: false, merged: false, blocked: [] };
  if (sandboxApplyAllowed && gateEval.pass) {
    const approvalA = cleanText(args['approval-a'] || args.approval_a || '', 120);
    const approvalB = cleanText(args['approval-b'] || args.approval_b || '', 120);
    if (!row.sandbox_id) {
      const proposeRun = mockMode
        ? { ok: true, payload: { ok: true, record: { sandbox_id: stableId(`${proposalId}|${ts}`, 'sb') } } }
        : runNodeJson(
          SELF_CODE_EVOLUTION_SCRIPT,
          ['propose', `--target-path=${row.target_path}`, `--summary=${row.summary}`, `--risk=${row.risk}`],
          'self_code_evolution_propose'
        );
      if (proposeRun.ok && proposeRun.payload && proposeRun.payload.record) {
        row.sandbox_id = cleanText(proposeRun.payload.record.sandbox_id || '', 120) || null;
        sandboxOps.proposed = true;
      } else {
        sandboxOps.blocked.push('sandbox_propose_failed');
      }
    }
    if (row.sandbox_id) {
      const testRun = mockMode
        ? { ok: true, payload: { ok: true } }
        : runNodeJson(
          SELF_CODE_EVOLUTION_SCRIPT,
          ['test', `--sandbox-id=${row.sandbox_id}`],
          'self_code_evolution_test'
        );
      if (testRun.ok) sandboxOps.tested = true;
      else sandboxOps.blocked.push('sandbox_test_failed');

      if (sandboxOps.tested && row.stage === 'live') {
        if (!approvalA || !approvalB) {
          sandboxOps.blocked.push('merge_approvals_missing');
        } else {
          const mergeRun = mockMode
            ? { ok: true, payload: { ok: true } }
            : runNodeJson(
              SELF_CODE_EVOLUTION_SCRIPT,
              [
                'merge',
                `--sandbox-id=${row.sandbox_id}`,
                `--approval-a=${approvalA}`,
                `--approval-b=${approvalB}`,
                '--apply=1'
              ],
              'self_code_evolution_merge'
            );
          if (mergeRun.ok) {
            sandboxOps.merged = true;
            row.status = 'live_merged';
          } else {
            sandboxOps.blocked.push('sandbox_merge_failed');
          }
        }
      }
    }
  } else if (applyRequested && policy.shadow_only) {
    sandboxOps.blocked.push('shadow_only_mode');
  }

  row.history.push({
    ts,
    transition,
    status: row.status,
    stage: row.stage,
    gates: gateEval.gates,
    symbiosis_recursion_gate: symbiosisGate
  });
  state.proposals[proposalId] = row;
  row.symbiosis_recursion_gate = symbiosisGate;
  saveState(policy, state);

  const out = {
    ok: simRun.ok && redRun.ok,
    type: 'gated_self_improvement_run',
    ts,
    proposal_id: proposalId,
    transition,
    stage: row.stage,
    status: row.status,
    apply_requested: applyRequested,
    sandbox_apply_allowed: sandboxApplyAllowed,
    gates: gateEval,
    simulation: {
      ok: simRun.ok,
      metrics: simMetrics
    },
    redteam: {
      ok: redRun.ok,
      summary: redSummary
    },
    budget_oracle: burnOracle,
    sandbox: sandboxOps,
    rollback,
    symbiosis_recursion_gate: symbiosisGate
  };
  persistLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdRollback(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120);
  const row = proposalId ? state.proposals[proposalId] : null;
  if (!row) {
    const out = { ok: false, type: 'gated_self_improvement_rollback', error: 'proposal_not_found', proposal_id: proposalId || null };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const ts = nowIso();
  let rollbackReceiptId = null;
  if (row.sandbox_id) {
    const rb = runNodeJson(
      SELF_CODE_EVOLUTION_SCRIPT,
      ['rollback', `--sandbox-id=${row.sandbox_id}`, `--reason=${cleanText(args.reason || 'manual_rollback', 120) || 'manual_rollback'}`],
      'self_code_evolution_rollback'
    );
    rollbackReceiptId = cleanText(
      rb
      && rb.payload
      && rb.payload.record
      && rb.payload.record.rollback
      && rb.payload.record.rollback.rollback_receipt_id,
      120
    ) || stableId(`${proposalId}|${ts}`, 'rb');
  } else {
    rollbackReceiptId = stableId(`${proposalId}|${ts}|no_sandbox`, 'rb');
  }
  row.status = 'rolled_back';
  row.rollback_receipts.push({
    ts,
    reason: cleanText(args.reason || 'manual_rollback', 120) || 'manual_rollback',
    receipt_id: rollbackReceiptId
  });
  row.history.push({
    ts,
    transition: 'manual_rollback',
    status: row.status,
    stage: row.stage
  });
  state.proposals[proposalId] = row;
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'gated_self_improvement_rollback',
    ts,
    proposal_id: proposalId,
    rollback_receipt_id: rollbackReceiptId
  };
  persistLatest(policy, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120);
  const burnOracle = loadSelfImprovementBurnOracle();
  const out = proposalId
    ? {
        ok: true,
        type: 'gated_self_improvement_status',
        ts: nowIso(),
        proposal_id: proposalId,
        proposal: state.proposals[proposalId] || null,
        budget_oracle: burnOracle
      }
    : {
        ok: true,
        type: 'gated_self_improvement_status',
        ts: nowIso(),
        counts: {
          total: Object.keys(state.proposals || {}).length,
          proposed: Object.values(state.proposals || {}).filter((row: any) => row && row.status === 'proposed').length,
          gated_pass: Object.values(state.proposals || {}).filter((row: any) => row && row.status === 'gated_pass').length,
          live_ready: Object.values(state.proposals || {}).filter((row: any) => row && row.status === 'live_ready').length,
          live_merged: Object.values(state.proposals || {}).filter((row: any) => row && row.status === 'live_merged').length,
          rolled_back: Object.values(state.proposals || {}).filter((row: any) => row && row.status === 'rolled_back').length
        },
        budget_oracle: burnOracle
      };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/gated_self_improvement_loop.js propose --objective-id=<id> --target-path=<path> [--summary=...] [--risk=low|medium|high]');
  console.log('  node systems/autonomy/gated_self_improvement_loop.js run --proposal-id=<id> [--apply=1|0] [--approval-a=<id>] [--approval-b=<id>] [--days=N]');
  console.log('  node systems/autonomy/gated_self_improvement_loop.js rollback --proposal-id=<id> [--reason=...]');
  console.log('  node systems/autonomy/gated_self_improvement_loop.js status [--proposal-id=<id>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 64) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'propose') return cmdPropose(args);
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  evaluateGates,
  extractSimulationMetrics
};

#!/usr/bin/env node
'use strict';
export {};

/**
 * surface_budget_controller.js
 *
 * RM-125: sensor-driven capability envelope controller.
 *
 * Usage:
 *   node systems/hardware/surface_budget_controller.js run [--apply=1|0] [--strict=1|0]
 *   node systems/hardware/surface_budget_controller.js status
 */

const fs = require('fs');
const path = require('path');
const { readLatestEmbodiment, loadPolicy: loadEmbodimentPolicy, makeEmbodimentSnapshot } = require('./embodiment_layer.js');
const { appendCanonicalEvent } = require('../primitives/canonical_event_log.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SURFACE_BUDGET_POLICY_PATH
  ? path.resolve(String(process.env.SURFACE_BUDGET_POLICY_PATH))
  : path.join(ROOT, 'config', 'surface_budget_controller_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
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

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    apply_default: false,
    min_transition_seconds: 60,
    embodiment_policy_path: 'config/embodiment_layer_policy.json',
    embodiment_snapshot_path: 'state/hardware/embodiment/latest.json',
    runtime_state_path: 'state/runtime/scheduler_mode/latest.json',
    state_path: 'state/hardware/surface_budget/latest.json',
    receipts_path: 'state/hardware/surface_budget/receipts.jsonl',
    tiers: [
      {
        id: 'critical',
        max_score: 0.2,
        allow_modes: ['operational'],
        inversion_depth_cap: 0,
        dream_intensity_cap: 0,
        right_brain_max_ratio: 0,
        fractal_breadth_cap: 1,
        max_parallel_workflows: 1
      },
      {
        id: 'low',
        max_score: 0.4,
        allow_modes: ['operational', 'dream'],
        inversion_depth_cap: 1,
        dream_intensity_cap: 1,
        right_brain_max_ratio: 0.25,
        fractal_breadth_cap: 2,
        max_parallel_workflows: 2
      },
      {
        id: 'balanced',
        max_score: 0.75,
        allow_modes: ['operational', 'dream', 'inversion'],
        inversion_depth_cap: 2,
        dream_intensity_cap: 2,
        right_brain_max_ratio: 0.5,
        fractal_breadth_cap: 4,
        max_parallel_workflows: 6
      },
      {
        id: 'high',
        max_score: 1,
        allow_modes: ['operational', 'dream', 'inversion'],
        inversion_depth_cap: 5,
        dream_intensity_cap: 5,
        right_brain_max_ratio: 0.9,
        fractal_breadth_cap: 8,
        max_parallel_workflows: 24
      }
    ]
  };
}

function normalizeTier(row: AnyObj, fallbackId: string, fallbackMax: number) {
  const id = normalizeToken(row.id || fallbackId, 40) || fallbackId;
  const maxScore = clampNum(row.max_score, 0, 1, fallbackMax);
  const allowModes = Array.isArray(row.allow_modes)
    ? Array.from(new Set(row.allow_modes.map((v: unknown) => normalizeToken(v, 40)).filter(Boolean)))
    : ['operational'];
  return {
    id,
    max_score: maxScore,
    allow_modes: allowModes.length ? allowModes : ['operational'],
    inversion_depth_cap: clampInt(row.inversion_depth_cap, 0, 16, 0),
    dream_intensity_cap: clampInt(row.dream_intensity_cap, 0, 16, 0),
    right_brain_max_ratio: clampNum(row.right_brain_max_ratio, 0, 1, 0),
    fractal_breadth_cap: clampInt(row.fractal_breadth_cap, 1, 64, 1),
    max_parallel_workflows: clampInt(row.max_parallel_workflows, 1, 256, 1)
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const tiersRaw = Array.isArray(raw.tiers) && raw.tiers.length ? raw.tiers : base.tiers;
  const tiers: AnyObj[] = [];
  for (let i = 0; i < tiersRaw.length; i += 1) {
    const prevMax = i > 0 ? Number(tiers[i - 1].max_score || 0) : 0;
    const fallbackMax = i === tiersRaw.length - 1 ? 1 : Math.min(1, prevMax + 0.3);
    const t = normalizeTier(tiersRaw[i] && typeof tiersRaw[i] === 'object' ? tiersRaw[i] : {}, `tier_${i + 1}`, fallbackMax);
    t.max_score = Math.max(prevMax, t.max_score);
    tiers.push(t);
  }
  if (tiers.length && Number(tiers[tiers.length - 1].max_score) < 1) tiers[tiers.length - 1].max_score = 1;

  const rootPath = (value: unknown, fallback: string) => {
    const text = clean(value || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };

  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    apply_default: toBool(raw.apply_default, base.apply_default),
    min_transition_seconds: clampInt(raw.min_transition_seconds, 0, 86400, base.min_transition_seconds),
    embodiment_policy_path: rootPath(raw.embodiment_policy_path, base.embodiment_policy_path),
    embodiment_snapshot_path: rootPath(raw.embodiment_snapshot_path, base.embodiment_snapshot_path),
    runtime_state_path: rootPath(raw.runtime_state_path, base.runtime_state_path),
    state_path: rootPath(raw.state_path, base.state_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    tiers,
    policy_path: path.resolve(policyPath)
  };
}

function chooseTier(score: number, tiers: AnyObj[]) {
  const normalizedScore = clampNum(score, 0, 1, 0);
  for (const tier of tiers) {
    if (normalizedScore <= Number(tier.max_score || 0)) return tier;
  }
  return tiers[tiers.length - 1];
}

function readRuntimeMode(runtimeStatePath: string) {
  const state = readJson(runtimeStatePath, {});
  return {
    mode: normalizeToken(state.mode || 'operational', 40) || 'operational',
    updated_at: clean(state.updated_at || '', 40) || null
  };
}

function readLastBudget(policy: AnyObj) {
  return readJson(policy.state_path, {});
}

function maybeSenseEmbodiment(policy: AnyObj) {
  const explicit = readJson(policy.embodiment_snapshot_path, null);
  if (explicit && typeof explicit === 'object' && explicit.surface_budget && typeof explicit.surface_budget === 'object') {
    return explicit;
  }
  const override = process.env.SURFACE_BUDGET_CONTROLLER_EMBODIMENT_POLICY_PATH
    ? path.resolve(String(process.env.SURFACE_BUDGET_CONTROLLER_EMBODIMENT_POLICY_PATH))
    : policy.embodiment_policy_path;
  let snapshot = readLatestEmbodiment(override);
  if (!snapshot) {
    const ePolicy = loadEmbodimentPolicy(override);
    snapshot = makeEmbodimentSnapshot(ePolicy, 'auto');
  }
  return snapshot;
}

function evaluate(policy: AnyObj) {
  const snapshot = maybeSenseEmbodiment(policy);
  const score = clampNum(snapshot?.surface_budget?.score, 0, 1, 0);
  const tier = chooseTier(score, policy.tiers);
  const runtime = readRuntimeMode(policy.runtime_state_path);
  const allowModes = Array.isArray(tier.allow_modes) ? tier.allow_modes : ['operational'];
  const modeAllowed = allowModes.includes(runtime.mode);
  const recommendedMode = modeAllowed ? runtime.mode : (allowModes.includes('operational') ? 'operational' : allowModes[0] || 'operational');
  const last = readLastBudget(policy);
  const lastTs = clean(last.ts || '', 40);
  const nowTs = nowIso();
  const elapsedMs = Number.isFinite(Date.parse(lastTs)) ? (Date.parse(nowTs) - Date.parse(lastTs)) : Number.POSITIVE_INFINITY;
  const canTransition = elapsedMs >= (Number(policy.min_transition_seconds || 0) * 1000);
  const transitionBlockedByCadence = !modeAllowed && !canTransition;

  const controls = {
    allow_modes: allowModes,
    inversion_depth_cap: Number(tier.inversion_depth_cap || 0),
    dream_intensity_cap: Number(tier.dream_intensity_cap || 0),
    right_brain_max_ratio: Number(tier.right_brain_max_ratio || 0),
    fractal_breadth_cap: Number(tier.fractal_breadth_cap || 0),
    max_parallel_workflows: Number(tier.max_parallel_workflows || 1)
  };

  const ok = policy.enabled === true
    && !!snapshot
    && Number.isFinite(score)
    && Array.isArray(controls.allow_modes)
    && controls.allow_modes.length >= 1
    && (!transitionBlockedByCadence);

  return {
    schema_id: 'surface_budget_controller',
    schema_version: '1.0',
    ts: nowTs,
    ok,
    policy_path: rel(policy.policy_path),
    budget: {
      score,
      tier_id: tier.id,
      profile_id: clean(snapshot?.profile_id || '', 40) || null,
      factors: snapshot && snapshot.surface_budget && typeof snapshot.surface_budget.factors === 'object'
        ? snapshot.surface_budget.factors
        : {}
    },
    runtime_mode: runtime.mode,
    mode_allowed: modeAllowed,
    recommended_mode: recommendedMode,
    transition_blocked_by_cadence: transitionBlockedByCadence,
    controls,
    paths: {
      embodiment_snapshot_path: rel(policy.embodiment_snapshot_path),
      runtime_state_path: rel(policy.runtime_state_path),
      state_path: rel(policy.state_path),
      receipts_path: rel(policy.receipts_path)
    }
  };
}

function applyRuntimeTransition(policy: AnyObj, payload: AnyObj) {
  if (payload.mode_allowed === true) return { applied: false, reason: 'mode_allowed' };
  if (payload.transition_blocked_by_cadence === true) return { applied: false, reason: 'cadence_window' };
  const current = readJson(policy.runtime_state_path, {});
  const nextState = {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: payload.recommended_mode || 'operational',
    updated_at: nowIso(),
    reason: 'surface_budget_enforced'
  };
  writeJsonAtomic(policy.runtime_state_path, nextState);
  appendCanonicalEvent({
    type: 'surface_budget_mode_enforced',
    phase: 'apply',
    opcode: 'FLOW_GATE',
    effect: 'governance',
    ok: true,
    payload: {
      from_mode: normalizeToken(current.mode || 'operational', 40) || 'operational',
      to_mode: nextState.mode,
      tier_id: payload.budget && payload.budget.tier_id ? payload.budget.tier_id : null,
      score: payload.budget && typeof payload.budget.score === 'number' ? payload.budget.score : null
    }
  });
  return { applied: true, reason: 'mode_not_allowed', from_mode: current.mode || 'operational', to_mode: nextState.mode };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'surface_budget_run', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const apply = toBool(args.apply, policy.apply_default === true);
  const payload = evaluate(policy);
  const applied = apply ? applyRuntimeTransition(policy, payload) : { applied: false, reason: 'shadow_only' };
  const out = {
    ...payload,
    type: 'surface_budget_run',
    apply,
    apply_result: applied
  };
  writeJsonAtomic(policy.state_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.state_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'surface_budget_status',
    ts: nowIso(),
    latest,
    policy: {
      path: rel(policy.policy_path),
      version: policy.version,
      min_transition_seconds: policy.min_transition_seconds,
      tiers: policy.tiers
    },
    paths: {
      runtime_state_path: rel(policy.runtime_state_path),
      state_path: rel(policy.state_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/surface_budget_controller.js run [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/hardware/surface_budget_controller.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  evaluate
};

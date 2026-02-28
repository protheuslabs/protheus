#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { appendCanonicalEvent } = require('./canonical_event_log.js');
const {
  readLatestEmbodiment,
  loadPolicy: loadEmbodimentPolicy,
  makeEmbodimentSnapshot
} = require('../hardware/embodiment_layer.js');
const {
  loadPolicy: loadSurfaceBudgetPolicy,
  evaluate: evaluateSurfaceBudget
} = require('../hardware/surface_budget_controller.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.RUNTIME_SCHEDULER_POLICY_PATH
  ? path.resolve(process.env.RUNTIME_SCHEDULER_POLICY_PATH)
  : path.join(ROOT, 'config', 'runtime_scheduler_policy.json');
const BACKGROUND_RUNTIME_SCRIPT = process.env.BACKGROUND_PERSISTENT_RUNTIME_SCRIPT
  ? path.resolve(process.env.BACKGROUND_PERSISTENT_RUNTIME_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'background_persistent_agent_runtime.js');
const DREAM_WARDEN_SCRIPT = process.env.DREAM_WARDEN_SCRIPT_PATH
  ? path.resolve(process.env.DREAM_WARDEN_SCRIPT_PATH)
  : path.join(ROOT, 'systems', 'security', 'dream_warden_guard.js');

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/runtime_scheduler.js status');
  console.log('  node systems/primitives/runtime_scheduler.js switch --mode=<operational|dream|inversion> [--reason=<text>] [--apply=1|0]');
  console.log('  node systems/primitives/runtime_scheduler.js trigger-persistent [--context-json="{...}"] [--source=<id>] [--apply=1|0]');
  console.log('  node systems/primitives/runtime_scheduler.js trigger-dream-warden [YYYY-MM-DD] [--apply=1|0] [--source=<id>]');
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

function parseJsonFromOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runBackgroundPersistentRuntime(cmd: string, args: string[] = []) {
  if (!fs.existsSync(BACKGROUND_RUNTIME_SCRIPT)) {
    return {
      ok: false,
      error: 'background_runtime_script_missing',
      script: path.relative(ROOT, BACKGROUND_RUNTIME_SCRIPT).replace(/\\/g, '/')
    };
  }
  const proc = spawnSync(process.execPath, [BACKGROUND_RUNTIME_SCRIPT, cmd, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonFromOutput(proc.stdout);
  return {
    ok: Number(proc.status) === 0 && payload && payload.ok === true,
    code: Number(proc.status == null ? 1 : proc.status),
    payload,
    stderr: cleanText(proc.stderr || '', 500)
  };
}

function runDreamWarden(cmd: string, args: string[] = []) {
  if (!fs.existsSync(DREAM_WARDEN_SCRIPT)) {
    return {
      ok: false,
      error: 'dream_warden_script_missing',
      script: path.relative(ROOT, DREAM_WARDEN_SCRIPT).replace(/\\/g, '/')
    };
  }
  const proc = spawnSync(process.execPath, [DREAM_WARDEN_SCRIPT, cmd, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parseJsonFromOutput(proc.stdout);
  return {
    ok: Number(proc.status) === 0 && payload && payload.ok === true,
    code: Number(proc.status == null ? 1 : proc.status),
    payload,
    stderr: cleanText(proc.stderr || '', 500)
  };
}

function embodimentSummary() {
  const policyPath = process.env.EMBODIMENT_LAYER_POLICY_PATH
    ? path.resolve(process.env.EMBODIMENT_LAYER_POLICY_PATH)
    : undefined;
  let snapshot = readLatestEmbodiment(policyPath);
  if (!snapshot) {
    const policy = loadEmbodimentPolicy(policyPath);
    snapshot = makeEmbodimentSnapshot(policy, 'auto');
  }
  return {
    profile_id: cleanText(snapshot && snapshot.profile_id || '', 40) || 'unknown',
    surface_budget_score: snapshot && snapshot.surface_budget && typeof snapshot.surface_budget.score === 'number'
      ? Number(snapshot.surface_budget.score)
      : null,
    max_parallel_workflows: snapshot && snapshot.capability_envelope
      ? Number(snapshot.capability_envelope.max_parallel_workflows || 0)
      : null,
    inversion_depth_cap: snapshot && snapshot.capability_envelope
      ? Number(snapshot.capability_envelope.inversion_depth_cap || 0)
      : null
  };
}

function surfaceBudgetSummary() {
  try {
    const policy = loadSurfaceBudgetPolicy();
    const budget = evaluateSurfaceBudget(policy);
    return {
      tier_id: cleanText(budget?.budget?.tier_id || '', 40) || null,
      score: typeof budget?.budget?.score === 'number' ? Number(budget.budget.score) : null,
      allow_modes: Array.isArray(budget?.controls?.allow_modes) ? budget.controls.allow_modes : [],
      inversion_depth_cap: Number.isFinite(Number(budget?.controls?.inversion_depth_cap))
        ? Number(budget.controls.inversion_depth_cap)
        : null,
      dream_intensity_cap: Number.isFinite(Number(budget?.controls?.dream_intensity_cap))
        ? Number(budget.controls.dream_intensity_cap)
        : null,
      right_brain_max_ratio: Number.isFinite(Number(budget?.controls?.right_brain_max_ratio))
        ? Number(budget.controls.right_brain_max_ratio)
        : null,
      fractal_breadth_cap: Number.isFinite(Number(budget?.controls?.fractal_breadth_cap))
        ? Number(budget.controls.fractal_breadth_cap)
        : null
    };
  } catch {
    return {
      tier_id: null,
      score: null,
      allow_modes: [],
      inversion_depth_cap: null,
      dream_intensity_cap: null,
      right_brain_max_ratio: null,
      fractal_breadth_cap: null
    };
  }
}

function defaultPolicy() {
  return {
    schema_id: 'runtime_scheduler_policy',
    schema_version: '1.0',
    enabled: true,
    default_mode: 'operational',
    modes: ['operational', 'dream', 'inversion'],
    allowed_transitions: {
      operational: ['operational', 'dream', 'inversion'],
      dream: ['dream', 'operational'],
      inversion: ['inversion', 'operational']
    },
    state_path: 'state/runtime/scheduler_mode/latest.json',
    receipts_path: 'state/runtime/scheduler_mode/receipts.jsonl'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const modes = Array.isArray(src.modes) ? src.modes : base.modes;
  const normalizedModes = Array.from(new Set(modes.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)));
  const allowedRaw = src.allowed_transitions && typeof src.allowed_transitions === 'object'
    ? src.allowed_transitions
    : base.allowed_transitions;
  const allowedTransitions: Record<string, string[]> = {};
  for (const mode of normalizedModes) {
    const list = Array.isArray((allowedRaw as AnyObj)[mode])
      ? (allowedRaw as AnyObj)[mode]
      : Array.isArray((base.allowed_transitions as AnyObj)[mode])
        ? (base.allowed_transitions as AnyObj)[mode]
        : [mode];
    const normalized = Array.from(new Set(list.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)));
    allowedTransitions[mode] = normalized.length ? normalized : [mode];
  }
  const defaultMode = normalizeToken(src.default_mode || base.default_mode, 40) || 'operational';
  return {
    schema_id: 'runtime_scheduler_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    default_mode: normalizedModes.includes(defaultMode) ? defaultMode : normalizedModes[0] || 'operational',
    modes: normalizedModes.length ? normalizedModes : base.modes.slice(0),
    allowed_transitions: allowedTransitions,
    state_path: path.resolve(ROOT, cleanText(src.state_path || base.state_path, 320)),
    receipts_path: path.resolve(ROOT, cleanText(src.receipts_path || base.receipts_path, 320))
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state_path, {});
  const mode = normalizeToken(src.mode || policy.default_mode, 40) || policy.default_mode;
  return {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: policy.modes.includes(mode) ? mode : policy.default_mode,
    updated_at: cleanText(src.updated_at || nowIso(), 40) || nowIso(),
    reason: cleanText(src.reason || 'default', 240) || 'default'
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    schema_id: 'runtime_scheduler_state',
    schema_version: '1.0',
    mode: normalizeToken(state.mode || policy.default_mode, 40) || policy.default_mode,
    updated_at: nowIso(),
    reason: cleanText(state.reason || 'unspecified', 240) || 'unspecified'
  });
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const allowedNext = policy.allowed_transitions[state.mode] || [];
  const embodiment = embodimentSummary();
  const surface_budget = surfaceBudgetSummary();
  const persistentRuntime = runBackgroundPersistentRuntime('status');
  const dreamWarden = runDreamWarden('status');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'runtime_scheduler_status',
    mode: state.mode,
    reason: state.reason,
    updated_at: state.updated_at,
    allowed_next_modes: allowedNext,
    policy_version: policy.schema_version,
    embodiment,
    surface_budget,
    persistent_runtime: persistentRuntime && typeof persistentRuntime.payload === 'object'
      ? {
          ok: persistentRuntime.ok === true,
          queue_depth: Number(persistentRuntime.payload.queue_depth || 0),
          tick_count: Number(persistentRuntime.payload.tick_count || 0),
          last_tick_ts: persistentRuntime.payload.last_tick_ts || null
        }
      : { ok: false },
    dream_warden: dreamWarden && typeof dreamWarden.payload === 'object'
      ? {
          ok: dreamWarden.ok === true,
          mode: dreamWarden.payload.mode || null,
          activation_ready: dreamWarden.payload.activation_ready === true,
          patch_proposals_count: Number(dreamWarden.payload.patch_proposals_count || 0),
          ts: dreamWarden.payload.ts || null
        }
      : {
          ok: false
        }
  })}\n`);
}

function cmdSwitch(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'runtime_scheduler_switch', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const targetMode = normalizeToken(args.mode || '', 40);
  if (!targetMode || !policy.modes.includes(targetMode)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_scheduler_switch',
      error: 'mode_not_allowed',
      mode: targetMode || null,
      allowed_modes: policy.modes
    })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, true);
  const reason = cleanText(args.reason || 'manual_switch', 240) || 'manual_switch';
  const state = loadState(policy);
  const currentMode = normalizeToken(state.mode || policy.default_mode, 40) || policy.default_mode;
  const allowedNext = policy.allowed_transitions[currentMode] || [currentMode];
  const surfaceBudget = surfaceBudgetSummary();
  if (!allowedNext.includes(targetMode)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_scheduler_switch',
      error: 'transition_not_allowed',
      from_mode: currentMode,
      to_mode: targetMode,
      allowed_next_modes: allowedNext
    })}\n`);
    process.exit(1);
  }
  if (Array.isArray(surfaceBudget.allow_modes) && surfaceBudget.allow_modes.length && !surfaceBudget.allow_modes.includes(targetMode)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'runtime_scheduler_switch',
      error: 'surface_budget_mode_block',
      from_mode: currentMode,
      to_mode: targetMode,
      allowed_modes_by_surface_budget: surfaceBudget.allow_modes,
      tier_id: surfaceBudget.tier_id,
      score: surfaceBudget.score
    })}\n`);
    process.exit(1);
  }

  const preview = {
    ok: true,
    type: 'runtime_scheduler_switch',
    apply,
    from_mode: currentMode,
    to_mode: targetMode,
    reason,
    embodiment: embodimentSummary(),
    surface_budget: surfaceBudget
  };
  if (apply) {
    saveState(policy, {
      mode: targetMode,
      reason
    });
    emitReceipt(policy, {
      type: 'runtime_scheduler_mode_switch',
      apply: true,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    });
    if (targetMode === 'operational') {
      const persistentTick = runBackgroundPersistentRuntime('tick', [
        '--source=runtime_scheduler_mode_switch',
        '--apply=0'
      ]);
      preview.persistent_runtime_probe = persistentTick && typeof persistentTick.payload === 'object'
        ? {
            ok: persistentTick.ok === true,
            activation_count: Number(persistentTick.payload.activation_count || 0),
            trigger_count: Array.isArray(persistentTick.payload.triggers)
              ? persistentTick.payload.triggers.length
              : 0
          }
        : {
            ok: false,
            error: cleanText(persistentTick && persistentTick.stderr || 'probe_failed', 120)
          };
    }
  } else {
    emitReceipt(policy, {
      type: 'runtime_scheduler_mode_switch_preview',
      apply: false,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    });
  }
  appendCanonicalEvent({
    type: 'runtime_scheduler_mode_switch',
    phase: 'switch',
    opcode: 'FLOW_GATE',
    effect: 'governance',
    ok: true,
    payload: {
      apply,
      from_mode: currentMode,
      to_mode: targetMode,
      reason
    }
  });
  process.stdout.write(`${JSON.stringify(preview)}\n`);
}

function cmdTriggerPersistent(args: AnyObj) {
  const apply = toBool(args.apply, false);
  const source = normalizeToken(args.source || 'runtime_scheduler', 120) || 'runtime_scheduler';
  const context = String(args['context-json'] || args.context_json || '').trim();
  const tickArgs = [
    `--source=${source}`,
    `--apply=${apply ? 1 : 0}`
  ];
  if (context) tickArgs.push(`--context-json=${context}`);
  const tick = runBackgroundPersistentRuntime('tick', tickArgs);
  const out = {
    ok: tick.ok === true,
    type: 'runtime_scheduler_trigger_persistent',
    source,
    apply,
    tick: tick.payload || null,
    error: tick.ok === true ? null : cleanText(tick.stderr || 'persistent_tick_failed', 200)
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

function cmdTriggerDreamWarden(args: AnyObj) {
  const apply = toBool(args.apply, false);
  const source = normalizeToken(args.source || 'runtime_scheduler', 120) || 'runtime_scheduler';
  const date = toDate(args._[1] || args.date || nowIso().slice(0, 10));
  const runArgs = [
    date,
    `--apply=${apply ? 1 : 0}`
  ];
  const run = runDreamWarden('run', runArgs);
  const out = {
    ok: run.ok === true,
    type: 'runtime_scheduler_trigger_dream_warden',
    source,
    date,
    apply,
    run: run.payload || null,
    error: run.ok === true ? null : cleanText(run.stderr || 'dream_warden_trigger_failed', 200)
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus(args);
  if (cmd === 'switch') return cmdSwitch(args);
  if (cmd === 'trigger-persistent') return cmdTriggerPersistent(args);
  if (cmd === 'trigger-dream-warden') return cmdTriggerDreamWarden(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

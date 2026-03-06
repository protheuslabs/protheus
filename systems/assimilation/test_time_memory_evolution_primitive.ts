#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.TEST_TIME_MEMORY_EVOLUTION_ROOT
  ? path.resolve(process.env.TEST_TIME_MEMORY_EVOLUTION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.TEST_TIME_MEMORY_EVOLUTION_POLICY_PATH
  ? path.resolve(process.env.TEST_TIME_MEMORY_EVOLUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'test_time_memory_evolution_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 280) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 140) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
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
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/test_time_memory_evolution_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/test_time_memory_evolution_primitive.js status [--capability-id=<id>] [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'test_time_memory_evolution_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    search: {
      max_episode_candidates: 180,
      max_synthesized_insights: 6,
      novelty_bias: 0.35
    },
    evolution: {
      reward_gain: 0.18,
      penalty_gain: 0.24,
      decay: 0.95,
      target_step_reduction: 0.5,
      max_step_reduction: 0.82
    },
    state: {
      memory_graph_path: 'state/assimilation/memory_evolution/episodes.jsonl',
      state_path: 'state/assimilation/test_time_memory_evolution/state.json',
      latest_path: 'state/assimilation/test_time_memory_evolution/latest.json',
      receipts_path: 'state/assimilation/test_time_memory_evolution/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const search = raw.search && typeof raw.search === 'object' ? raw.search : {};
  const evolution = raw.evolution && typeof raw.evolution === 'object' ? raw.evolution : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    search: {
      max_episode_candidates: clampInt(search.max_episode_candidates, 1, 20000, base.search.max_episode_candidates),
      max_synthesized_insights: clampInt(search.max_synthesized_insights, 1, 64, base.search.max_synthesized_insights),
      novelty_bias: clampNumber(search.novelty_bias, 0, 1, base.search.novelty_bias)
    },
    evolution: {
      reward_gain: clampNumber(evolution.reward_gain, 0, 1, base.evolution.reward_gain),
      penalty_gain: clampNumber(evolution.penalty_gain, 0, 1, base.evolution.penalty_gain),
      decay: clampNumber(evolution.decay, 0, 1, base.evolution.decay),
      target_step_reduction: clampNumber(
        evolution.target_step_reduction,
        0,
        0.95,
        base.evolution.target_step_reduction
      ),
      max_step_reduction: clampNumber(evolution.max_step_reduction, 0, 0.95, base.evolution.max_step_reduction)
    },
    state: {
      memory_graph_path: resolvePath(state.memory_graph_path || base.state.memory_graph_path, base.state.memory_graph_path),
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'test_time_memory_evolution_state',
      schema_version: '1.0',
      updated_at: null,
      capabilities: {}
    };
  }
  return {
    schema_id: 'test_time_memory_evolution_state',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {}
  };
}

function loadEpisodes(policy: AnyObj, capabilityId: string) {
  const rows = readJsonl(policy.state.memory_graph_path);
  const cap = String(capabilityId || '');
  const filtered = rows.filter((row: AnyObj) => String(row && row.capability_id || '') === cap);
  return filtered.slice(-Number(policy.search.max_episode_candidates || 180));
}

function runTestTimeMemoryEvolution(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'test_time_memory_evolution_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';
  const outcome = normalizeToken(inputRaw.outcome || 'shadow_only', 32) || 'shadow_only';
  const interactionId = normalizeToken(inputRaw.interaction_id || `${capabilityId}_${ts}`, 180);
  const observedSteps = clampInt(inputRaw.observed_steps, 1, 1000000, 12);

  const episodes = loadEpisodes(policy, capabilityId);
  const successRows = episodes.filter((row: AnyObj) => normalizeToken(row && row.outcome || '', 32) === 'success');
  const failRows = episodes.filter((row: AnyObj) => normalizeToken(row && row.outcome || '', 32) === 'fail');
  const outcomeDelta = outcome === 'success'
    ? policy.evolution.reward_gain
    : outcome === 'fail'
      ? (-1 * policy.evolution.penalty_gain)
      : (outcome === 'reject' ? (-0.5 * policy.evolution.penalty_gain) : 0.03);
  const noveltyBoost = Number(policy.search.novelty_bias || 0) * (episodes.length > 0 ? (1 / Math.sqrt(episodes.length + 1)) : 1);

  const state = loadState(policy.state.state_path);
  const prev = state.capabilities[capabilityId] && typeof state.capabilities[capabilityId] === 'object'
    ? state.capabilities[capabilityId]
    : {
      interactions: 0,
      estimated_step_reduction: 0,
      memory_fitness: 0,
      last_interaction_id: null,
      updated_at: null
    };

  const prevReduction = clampNumber(prev.estimated_step_reduction, 0, 0.95, 0);
  const evolvedFitness = clampNumber(
    (Number(prev.memory_fitness || 0) * Number(policy.evolution.decay || 0.95))
      + outcomeDelta
      + noveltyBoost,
    -1,
    1,
    0
  );
  const evolvedReduction = clampNumber(
    prevReduction
      + (outcomeDelta * 0.22)
      + (evolvedFitness * 0.1)
      + ((successRows.length > failRows.length) ? 0.015 : -0.01),
    0,
    Number(policy.evolution.max_step_reduction || 0.82),
    0
  );

  const synthesizedInsights = [
    successRows.length >= failRows.length
      ? 'preserve_high-yield context clusters'
      : 'increase exploration near failed branches',
    evolvedFitness >= 0
      ? 'bias toward short successful trajectories'
      : 'rebalance retrieval toward corrective exemplars',
    evolvedReduction >= Number(policy.evolution.target_step_reduction || 0.5)
      ? 'target reduction reached; hold steady and validate'
      : 'continue iterative memory refinement toward target reduction'
  ].slice(0, Number(policy.search.max_synthesized_insights || 6));

  const predictedSteps = Math.max(1, Math.round(observedSteps * (1 - evolvedReduction)));

  const snapshot = {
    interactions: clampInt(prev.interactions, 0, 1000000000, 0) + 1,
    estimated_step_reduction: evolvedReduction,
    memory_fitness: evolvedFitness,
    last_interaction_id: interactionId,
    updated_at: ts
  };
  state.capabilities[capabilityId] = snapshot;
  state.updated_at = ts;

  const out = {
    ok: true,
    type: 'test_time_memory_evolution_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    interaction_id: interactionId,
    outcome,
    search: {
      sampled_episode_count: episodes.length,
      success_count: successRows.length,
      fail_count: failRows.length,
      novelty_boost: Number(noveltyBoost.toFixed(6))
    },
    synthesized_insights: synthesizedInsights,
    evolution: {
      target_step_reduction: Number(policy.evolution.target_step_reduction || 0),
      previous_step_reduction: Number(prevReduction.toFixed(6)),
      estimated_step_reduction: Number(evolvedReduction.toFixed(6)),
      memory_fitness: Number(evolvedFitness.toFixed(6)),
      predicted_steps: predictedSteps,
      observed_steps: observedSteps,
      reduction_delta: Number((evolvedReduction - prevReduction).toFixed(6))
    },
    state_path: rel(policy.state.state_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state.state_path, state);
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandRun(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.TEST_TIME_MEMORY_EVOLUTION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const input = parseJsonArg(args['input-json'] || args.input_json, {});
  return runTestTimeMemoryEvolution(input, {
    policyPath,
    apply: toBool(args.apply, false)
  });
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.TEST_TIME_MEMORY_EVOLUTION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.state.latest_path, null);
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  const state = loadState(policy.state.state_path);
  return {
    ok: true,
    type: 'test_time_memory_evolution_status',
    ts: nowIso(),
    capability_id: capabilityId || null,
    snapshot: capabilityId
      ? (state.capabilities[capabilityId] || null)
      : null,
    tracked_capabilities: Object.keys(state.capabilities || {}).length,
    latest: latest && typeof latest === 'object'
      ? {
        capability_id: latest.capability_id || null,
        estimated_step_reduction: latest.evolution ? latest.evolution.estimated_step_reduction : null,
        ts: latest.ts || null
      }
      : null,
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.state.state_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  try {
    let out: AnyObj;
    if (cmd === 'run') out = commandRun(args);
    else if (cmd === 'status') out = commandStatus(args);
    else if (!cmd || cmd === '--help' || cmd === 'help') {
      usage();
      process.exit(0);
      return;
    } else {
      throw new Error(`unknown_command:${cmd}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'test_time_memory_evolution_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'run_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  runTestTimeMemoryEvolution,
  commandRun,
  commandStatus,
  loadPolicy
};

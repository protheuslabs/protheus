#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.MEMORY_EVOLUTION_ROOT
  ? path.resolve(process.env.MEMORY_EVOLUTION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.MEMORY_EVOLUTION_POLICY_PATH
  ? path.resolve(process.env.MEMORY_EVOLUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_evolution_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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
  console.log('  node systems/assimilation/memory_evolution_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/memory_evolution_primitive.js status [--capability-id=<id>] [--policy=<path>]');
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
    schema_id: 'memory_evolution_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    learning_rate: 0.22,
    discount_factor: 0.85,
    retrieval: {
      two_phase_enabled: true,
      max_recent_episodes: 120,
      max_graph_events: 60,
      require_capability_match: true
    },
    rewards: {
      success: 0.12,
      shadow_only: 0.02,
      reject: -0.1,
      fail: -0.2,
      environment_weight: 0.18,
      duality_weight: 0.08
    },
    doctor_feedback: {
      enabled: true,
      queue_path: 'state/ops/autotest_doctor/memory_evolution_feedback.jsonl',
      q_alert_threshold: -0.15
    },
    state: {
      root: 'state/assimilation/memory_evolution',
      q_values_path: 'state/assimilation/memory_evolution/q_values.json',
      episodes_path: 'state/assimilation/memory_evolution/episodes.jsonl',
      latest_path: 'state/assimilation/memory_evolution/latest.json',
      receipts_path: 'state/assimilation/memory_evolution/receipts.jsonl',
      causal_graph_state_path: 'state/memory/causal_temporal_graph/state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const retrieval = raw.retrieval && typeof raw.retrieval === 'object' ? raw.retrieval : {};
  const rewards = raw.rewards && typeof raw.rewards === 'object' ? raw.rewards : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const doctor = raw.doctor_feedback && typeof raw.doctor_feedback === 'object' ? raw.doctor_feedback : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    learning_rate: clampNumber(raw.learning_rate, 0.01, 1, base.learning_rate),
    discount_factor: clampNumber(raw.discount_factor, 0, 1, base.discount_factor),
    retrieval: {
      two_phase_enabled: retrieval.two_phase_enabled !== false,
      max_recent_episodes: clampNumber(retrieval.max_recent_episodes, 1, 5000, base.retrieval.max_recent_episodes),
      max_graph_events: clampNumber(retrieval.max_graph_events, 0, 5000, base.retrieval.max_graph_events),
      require_capability_match: retrieval.require_capability_match !== false
    },
    rewards: {
      success: clampNumber(rewards.success, -1, 1, base.rewards.success),
      shadow_only: clampNumber(rewards.shadow_only, -1, 1, base.rewards.shadow_only),
      reject: clampNumber(rewards.reject, -1, 1, base.rewards.reject),
      fail: clampNumber(rewards.fail, -1, 1, base.rewards.fail),
      environment_weight: clampNumber(rewards.environment_weight, 0, 1, base.rewards.environment_weight),
      duality_weight: clampNumber(rewards.duality_weight, 0, 1, base.rewards.duality_weight)
    },
    doctor_feedback: {
      enabled: doctor.enabled !== false,
      queue_path: resolvePath(doctor.queue_path || base.doctor_feedback.queue_path, base.doctor_feedback.queue_path),
      q_alert_threshold: clampNumber(doctor.q_alert_threshold, -1, 1, base.doctor_feedback.q_alert_threshold)
    },
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      q_values_path: resolvePath(state.q_values_path || base.state.q_values_path, base.state.q_values_path),
      episodes_path: resolvePath(state.episodes_path || base.state.episodes_path, base.state.episodes_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      causal_graph_state_path: resolvePath(
        state.causal_graph_state_path || base.state.causal_graph_state_path,
        base.state.causal_graph_state_path
      )
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadQValues(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'memory_evolution_q_values',
      schema_version: '1.0',
      updated_at: null,
      values: {}
    };
  }
  return {
    schema_id: 'memory_evolution_q_values',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    values: payload.values && typeof payload.values === 'object' ? payload.values : {}
  };
}

function queryRecentEpisodes(policy: AnyObj, capabilityId: string, sourceType: string) {
  const rows = readJsonl(policy.state.episodes_path).slice(-Number(policy.retrieval.max_recent_episodes || 120));
  return rows.filter((row: AnyObj) => {
    if (!row || typeof row !== 'object') return false;
    if (policy.retrieval.require_capability_match !== false) {
      return String(row.capability_id || '') === capabilityId;
    }
    return String(row.capability_id || '') === capabilityId || String(row.source_type || '') === sourceType;
  });
}

function queryCausalGraph(policy: AnyObj, capabilityId: string) {
  if (policy.retrieval.two_phase_enabled !== true) return [];
  const maxRows = Number(policy.retrieval.max_graph_events || 0);
  if (maxRows < 1) return [];
  const state = readJson(policy.state.causal_graph_state_path, {});
  const events = Array.isArray(state && state.events) ? state.events : [];
  const capNeedle = String(capabilityId || '').toLowerCase();
  const out: AnyObj[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const blob = JSON.stringify(event || {}).toLowerCase();
    if (!blob.includes(capNeedle)) continue;
    out.push({
      event_id: cleanText(event && event.event_id || '', 120) || null,
      ts: cleanText(event && event.ts || '', 64) || null,
      type: cleanText(event && event.type || '', 80) || null
    });
    if (out.length >= maxRows) break;
  }
  return out;
}

function outcomeReward(policy: AnyObj, outcome: string, environmentScore: number, dualityScore: number) {
  const rewardCfg = policy.rewards || {};
  const base = outcome === 'success'
    ? Number(rewardCfg.success || 0)
    : outcome === 'shadow_only'
      ? Number(rewardCfg.shadow_only || 0)
      : outcome === 'reject'
        ? Number(rewardCfg.reject || 0)
        : Number(rewardCfg.fail || 0);
  const envAdj = clampNumber(environmentScore, -1, 1, 0) * Number(rewardCfg.environment_weight || 0);
  const dualAdj = clampNumber(dualityScore, -1, 1, 0) * Number(rewardCfg.duality_weight || 0);
  return Number((base + envAdj + dualAdj).toFixed(6));
}

function runMemoryEvolution(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'memory_evolution_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160);
  if (!capabilityId) {
    return {
      ok: false,
      type: 'memory_evolution_primitive',
      error: 'capability_id_required'
    };
  }

  const sourceType = normalizeToken(inputRaw.source_type || 'external_tool', 80) || 'external_tool';
  const outcome = normalizeToken(inputRaw.outcome || 'shadow_only', 40) || 'shadow_only';
  const environmentScore = clampNumber(inputRaw.environment_score, -1, 1, 0);
  const dualityScore = clampNumber(inputRaw.duality_score, -1, 1, 0);

  const qState = loadQValues(policy.state.q_values_path);
  const previousQ = clampNumber(qState.values[capabilityId], -1, 1, 0);

  const phaseOne = queryRecentEpisodes(policy, capabilityId, sourceType);
  const phaseTwo = queryCausalGraph(policy, capabilityId);

  const bestFuture = phaseOne
    .slice(-24)
    .map((row: AnyObj) => clampNumber(row && row.q_after, -1, 1, 0))
    .sort((a: number, b: number) => b - a)[0] || 0;
  const reward = outcomeReward(policy, outcome, environmentScore, dualityScore);
  const lr = Number(policy.learning_rate || 0.22);
  const gamma = Number(policy.discount_factor || 0.85);
  const qAfter = clampNumber(previousQ + lr * (reward + (gamma * bestFuture) - previousQ), -1, 1, previousQ);

  const episode = {
    ts,
    capability_id: capabilityId,
    source_type: sourceType,
    outcome,
    reward,
    environment_score: environmentScore,
    duality_score: dualityScore,
    q_before: Number(previousQ.toFixed(6)),
    q_after: Number(qAfter.toFixed(6)),
    retrieval: {
      phase_one_matches: phaseOne.length,
      phase_two_matches: phaseTwo.length,
      phase_two_sample: phaseTwo.slice(0, 12)
    }
  };

  qState.values[capabilityId] = Number(qAfter.toFixed(6));
  qState.updated_at = ts;
  writeJsonAtomic(policy.state.q_values_path, qState);
  appendJsonl(policy.state.episodes_path, episode);

  let doctorQueued = false;
  if (policy.doctor_feedback.enabled === true && qAfter <= Number(policy.doctor_feedback.q_alert_threshold || -0.15)) {
    appendJsonl(policy.doctor_feedback.queue_path, {
      ts,
      type: 'memory_evolution_low_q_alert',
      capability_id: capabilityId,
      source_type: sourceType,
      q_after: Number(qAfter.toFixed(6)),
      threshold: Number(policy.doctor_feedback.q_alert_threshold || -0.15),
      recommendation: 'deprioritize_or_repair'
    });
    doctorQueued = true;
  }

  const out = {
    ok: true,
    type: 'memory_evolution_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    source_type: sourceType,
    outcome,
    q_before: Number(previousQ.toFixed(6)),
    q_after: Number(qAfter.toFixed(6)),
    reward,
    best_future_estimate: Number(bestFuture.toFixed(6)),
    retrieval: {
      phase_one_matches: phaseOne.length,
      phase_two_matches: phaseTwo.length
    },
    doctor_feedback_queued: doctorQueued,
    state_paths: {
      q_values_path: rel(policy.state.q_values_path),
      episodes_path: rel(policy.state.episodes_path)
    },
    policy: {
      path: rel(policy.policy_path || DEFAULT_POLICY_PATH),
      version: policy.schema_version
    }
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function status(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.state.latest_path, null);
  const qState = loadQValues(policy.state.q_values_path);
  const cap = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  if (cap) {
    return {
      ok: true,
      type: 'memory_evolution_status',
      capability_id: cap,
      q_value: clampNumber(qState.values[cap], -1, 1, 0),
      latest: latest && latest.capability_id === cap ? latest : null
    };
  }
  return {
    ok: true,
    type: 'memory_evolution_status',
    latest,
    tracked_capabilities: Object.keys(qState.values || {}).length,
    updated_at: qState.updated_at || null
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  try {
    if (cmd === 'status') {
      process.stdout.write(`${JSON.stringify(status(args))}\n`);
      return;
    }
    if (cmd === 'run') {
      const input = parseJsonArg(args['input-json'] || args.input_json || '{}', {});
      const out = runMemoryEvolution(input, {
        policyPath: args.policy,
        apply: args.apply
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(out && out.ok === true ? 0 : 1);
      return;
    }
    if (cmd === 'help') {
      usage();
      return;
    }
    throw new Error(`unknown_command:${cmd}`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'memory_evolution_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'memory_evolution_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  runMemoryEvolution
};

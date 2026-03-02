#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-040
 * Adaptive dream-model failover + cooldown memory.
 *
 * Usage:
 *   node systems/memory/dream_model_failover.js record --model=<id> --result=ok|timeout|error [--reason="..."] [--apply=1|0]
 *   node systems/memory/dream_model_failover.js select [--preferred=<id>] [--strict=1|0]
 *   node systems/memory/dream_model_failover.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.DREAM_MODEL_FAILOVER_ROOT
  ? path.resolve(process.env.DREAM_MODEL_FAILOVER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.DREAM_MODEL_FAILOVER_POLICY_PATH
  ? path.resolve(process.env.DREAM_MODEL_FAILOVER_POLICY_PATH)
  : path.join(ROOT, 'config', 'dream_model_failover_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.trunc(n);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    models: ['ollama/smallthinker', 'ollama/qwen3:4b'],
    base_cooldown_minutes: 30,
    max_cooldown_minutes: 360,
    outputs: {
      state_path: 'state/memory/dream_model_failover/state.json',
      latest_path: 'state/memory/dream_model_failover/latest.json',
      history_path: 'state/memory/dream_model_failover/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const models = Array.isArray(raw.models) ? raw.models.map((x) => cleanText(x, 120)).filter(Boolean) : base.models;
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    models: models.length ? Array.from(new Set(models)) : base.models,
    base_cooldown_minutes: clampInt(raw.base_cooldown_minutes, 1, 24 * 7, base.base_cooldown_minutes),
    max_cooldown_minutes: clampInt(raw.max_cooldown_minutes, 5, 24 * 30, base.max_cooldown_minutes),
    outputs: {
      state_path: resolvePath(outputs.state_path, base.outputs.state_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(statePath: string) {
  const raw = readJson(statePath, {
    version: 1,
    updated_at: null,
    model_health: {}
  });
  if (!raw || typeof raw !== 'object') {
    return {
      version: 1,
      updated_at: null,
      model_health: {}
    };
  }
  if (!raw.model_health || typeof raw.model_health !== 'object') raw.model_health = {};
  return raw;
}

function modelEntry(state: AnyObj, model: string) {
  const key = cleanText(model, 160);
  const prev = state.model_health[key] && typeof state.model_health[key] === 'object'
    ? state.model_health[key]
    : {
      model: key,
      failure_streak: 0,
      last_error: null,
      last_result: null,
      cooldown_until_ts: null,
      cooldown_minutes: 0,
      updated_at: null
    };
  return { key, prev };
}

function isCooldownActive(entry: AnyObj, nowMs: number) {
  const untilMs = Date.parse(String(entry && entry.cooldown_until_ts || ''));
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

function selectModel(policy: AnyObj, state: AnyObj, preferred: string | null = null) {
  const nowMs = Date.now();
  const ordered = preferred
    ? [preferred, ...policy.models.filter((m: string) => m !== preferred)]
    : policy.models.slice();
  for (const model of ordered) {
    const entry = state.model_health && state.model_health[model] ? state.model_health[model] : null;
    if (!entry || !isCooldownActive(entry, nowMs)) {
      return {
        selected_model: model,
        fallback: preferred && model !== preferred,
        reason: preferred && model !== preferred ? 'preferred_model_in_cooldown' : 'healthy_or_unknown'
      };
    }
  }
  return {
    selected_model: ordered[0] || null,
    fallback: false,
    reason: 'all_models_in_cooldown'
  };
}

function cmdRecord(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      apply,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const model = cleanText(args.model, 120);
  if (!model) return { ok: false, error: 'missing_model' };
  const result = cleanText(args.result || 'error', 60).toLowerCase();
  const reason = cleanText(args.reason || (result === 'ok' ? 'model_ok' : 'model_failure'), 220);

  const state = loadState(policy.outputs.state_path);
  const ent = modelEntry(state, model);
  const now = nowIso();

  let next = { ...ent.prev };
  next.model = ent.key;
  next.last_result = result;
  next.updated_at = now;

  if (result === 'ok') {
    next.failure_streak = 0;
    next.last_error = null;
    next.cooldown_until_ts = null;
    next.cooldown_minutes = 0;
  } else {
    const streak = Math.max(1, Number(ent.prev.failure_streak || 0) + 1);
    const cooldownMinutes = Math.min(
      Number(policy.max_cooldown_minutes || 360),
      Number(policy.base_cooldown_minutes || 30) * streak
    );
    next.failure_streak = streak;
    next.last_error = reason;
    next.cooldown_minutes = cooldownMinutes;
    next.cooldown_until_ts = new Date(Date.now() + (cooldownMinutes * 60 * 1000)).toISOString();
  }

  state.model_health[ent.key] = next;
  state.updated_at = now;
  if (apply) writeJsonAtomic(policy.outputs.state_path, state);

  const selected = selectModel(policy, state, policy.models[0] || null);
  const out = {
    ok: true,
    ts: now,
    type: 'dream_model_failover_record',
    strict,
    apply,
    model: ent.key,
    input_result: result,
    reason,
    health: next,
    selected,
    state_path: rel(policy.outputs.state_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    apply,
    model: ent.key,
    input_result: result,
    failure_streak: Number(next.failure_streak || 0),
    cooldown_until_ts: next.cooldown_until_ts || null,
    selected_model: selected.selected_model,
    selected_reason: selected.reason
  });

  return out;
}

function cmdSelect(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }
  const state = loadState(policy.outputs.state_path);
  const preferred = cleanText(args.preferred || policy.models[0] || '', 120) || null;
  const selected = selectModel(policy, state, preferred);
  const out = {
    ok: !!selected.selected_model,
    ts: nowIso(),
    type: 'dream_model_failover_select',
    preferred_model: preferred,
    selected,
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.outputs.state_path)
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    preferred_model: preferred,
    selected_model: selected.selected_model,
    fallback: selected.fallback,
    reason: selected.reason
  });
  if (!out.ok && strict) return { ...out, error: 'no_model_selected' };
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadState(policy.outputs.state_path);
  const nowMs = Date.now();
  const activeCooldowns = Object.values(state.model_health || {})
    .filter((entry: AnyObj) => isCooldownActive(entry, nowMs))
    .map((entry: AnyObj) => ({
      model: entry.model || null,
      cooldown_until_ts: entry.cooldown_until_ts || null,
      cooldown_minutes: Number(entry.cooldown_minutes || 0),
      failure_streak: Number(entry.failure_streak || 0)
    }));

  return {
    ok: true,
    ts: nowIso(),
    type: 'dream_model_failover_status',
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.outputs.state_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    active_model_cooldowns: activeCooldowns,
    known_models: policy.models
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/dream_model_failover.js record --model=<id> --result=ok|timeout|error [--reason="..."] [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/memory/dream_model_failover.js select [--preferred=<id>] [--strict=1|0]');
  console.log('  node systems/memory/dream_model_failover.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'record'
      ? cmdRecord(args)
      : cmd === 'select'
        ? cmdSelect(args)
        : cmd === 'status'
          ? cmdStatus(args)
          : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'dream_model_failover_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdRecord,
  cmdSelect,
  cmdStatus
};

#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-010
 * Model variant profile selector (`:thinking` vs base) with auto-return.
 *
 * Usage:
 *   node systems/routing/model_variant_profile.js select --model=<id> --task-type=<id> [--quality-gain=<pct>] [--apply=1|0] [--strict=1|0]
 *   node systems/routing/model_variant_profile.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.MODEL_VARIANT_PROFILE_ROOT
  ? path.resolve(process.env.MODEL_VARIANT_PROFILE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.MODEL_VARIANT_PROFILE_POLICY_PATH
  ? path.resolve(process.env.MODEL_VARIANT_PROFILE_POLICY_PATH)
  : path.join(ROOT, 'config', 'model_variant_profile_policy.json');

function nowIso() { return new Date().toISOString(); }

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
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

function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 120).toLowerCase();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    thinking_suffix: ':thinking',
    min_quality_gain_pct: 10,
    max_consecutive_thinking: 3,
    thinking_task_types: ['analysis', 'planning', 'diagnostics'],
    outputs: {
      state_path: 'state/routing/model_variant_profile/state.json',
      latest_path: 'state/routing/model_variant_profile/latest.json',
      history_path: 'state/routing/model_variant_profile/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    thinking_suffix: cleanText(raw.thinking_suffix || base.thinking_suffix, 40) || base.thinking_suffix,
    min_quality_gain_pct: clampNumber(raw.min_quality_gain_pct, 0, 1000, base.min_quality_gain_pct),
    max_consecutive_thinking: Math.max(1, Number(raw.max_consecutive_thinking || base.max_consecutive_thinking)),
    thinking_task_types: asStringArray(raw.thinking_task_types || base.thinking_task_types),
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
    consecutive_thinking: 0,
    last_selected_model: null,
    last_base_model: null,
    last_task_type: null,
    last_reason: null
  });
  if (!raw || typeof raw !== 'object') {
    return {
      version: 1,
      updated_at: null,
      consecutive_thinking: 0,
      last_selected_model: null,
      last_base_model: null,
      last_task_type: null,
      last_reason: null
    };
  }
  return raw;
}

function buildThinkingModel(baseModel: string, suffix: string) {
  const base = cleanText(baseModel, 160);
  if (!base) return null;
  const sfx = cleanText(suffix, 40) || ':thinking';
  if (base.endsWith(sfx)) return base;
  return `${base}${sfx}`;
}

function cmdSelect(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, apply, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const baseModel = cleanText(args.model, 160);
  if (!baseModel) return { ok: false, error: 'missing_model' };

  const taskType = cleanText(args['task-type'] || args.task_type || 'general', 80).toLowerCase() || 'general';
  const qualityGainPct = clampNumber(args['quality-gain'] || args.quality_gain || 0, -100, 1000, 0);

  const state = loadState(policy.outputs.state_path);
  const isThinkingTask = policy.thinking_task_types.includes(taskType);
  const gainJustified = qualityGainPct >= Number(policy.min_quality_gain_pct || 0);
  const thinkingBudgetRemaining = Number(state.consecutive_thinking || 0) < Number(policy.max_consecutive_thinking || 1);

  const chooseThinking = isThinkingTask && gainJustified && thinkingBudgetRemaining;
  const selectedModel = chooseThinking
    ? buildThinkingModel(baseModel, policy.thinking_suffix)
    : baseModel;

  const wasThinking = String(state.last_selected_model || '').endsWith(String(policy.thinking_suffix || ':thinking'));
  const autoReturned = wasThinking && !chooseThinking;
  const reason = chooseThinking
    ? 'thinking_variant_justified'
    : autoReturned
      ? 'auto_return_to_base_variant'
      : !isThinkingTask
        ? 'task_type_not_thinking_eligible'
        : !gainJustified
          ? 'quality_gain_below_threshold'
          : 'thinking_budget_exhausted';

  const nextState = {
    ...state,
    updated_at: nowIso(),
    consecutive_thinking: chooseThinking
      ? Math.max(1, Number(state.consecutive_thinking || 0) + 1)
      : 0,
    last_selected_model: selectedModel,
    last_base_model: baseModel,
    last_task_type: taskType,
    last_reason: reason
  };
  if (apply) writeJsonAtomic(policy.outputs.state_path, nextState);

  const out = {
    ok: !!selectedModel,
    ts: nowIso(),
    type: 'model_variant_profile_select',
    strict,
    apply,
    selected_model: selectedModel,
    base_model: baseModel,
    task_type: taskType,
    quality_gain_pct: Number(qualityGainPct.toFixed(4)),
    decision: {
      choose_thinking: chooseThinking,
      auto_returned: autoReturned,
      reason,
      consecutive_thinking: Number(nextState.consecutive_thinking || 0),
      max_consecutive_thinking: Number(policy.max_consecutive_thinking || 0),
      min_quality_gain_pct: Number(policy.min_quality_gain_pct || 0)
    },
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    selected_model: out.selected_model,
    base_model: out.base_model,
    task_type: out.task_type,
    quality_gain_pct: out.quality_gain_pct,
    choose_thinking: out.decision.choose_thinking,
    auto_returned: out.decision.auto_returned,
    reason: out.decision.reason,
    apply
  });

  if (!out.ok && strict) return { ...out, error: 'no_model_selected' };
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'model_variant_profile_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    state_path: rel(policy.outputs.state_path),
    state: loadState(policy.outputs.state_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/model_variant_profile.js select --model=<id> --task-type=<id> [--quality-gain=<pct>] [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/routing/model_variant_profile.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'select'
      ? cmdSelect(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'model_variant_profile_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdSelect,
  cmdStatus
};

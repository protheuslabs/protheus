#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.AUTONOMY_ROLLOUT_POLICY_PATH
  ? path.resolve(process.env.AUTONOMY_ROLLOUT_POLICY_PATH)
  : path.join(ROOT, 'config', 'autonomy_rollout_policy.json');
const DEFAULT_STATE_PATH = process.env.AUTONOMY_ROLLOUT_STATE_PATH
  ? path.resolve(process.env.AUTONOMY_ROLLOUT_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'rollout_state.json');
const DEFAULT_AUDIT_PATH = process.env.AUTONOMY_ROLLOUT_AUDIT_PATH
  ? path.resolve(process.env.AUTONOMY_ROLLOUT_AUDIT_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'rollout_events.jsonl');
const HARNESS_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'autonomy_simulation_harness.js');

function nowIso() {
  return new Date().toISOString();
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dateArgOrToday(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : todayUtc();
}

function toFiniteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function asText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function asBool(v, fallback = false) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return fallback;
}

function normalizeStage(v, fallback = 'shadow') {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'shadow') return 'shadow';
  if (s === 'canary') return 'canary';
  if (s === 'live') return 'live';
  return fallback;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function hoursSince(ts) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / (1000 * 60 * 60));
}

function daysSince(ts) {
  const h = hoursSince(ts);
  return h == null ? null : (h / 24);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const fallback = {
    version: '1.0',
    shadow_min_days: 7,
    canary_min_days: 14,
    canary_live_fraction: 0.15,
    canary_force_low_risk: true,
    canary_frozen_daily_token_cap: 4000,
    canary_max_runs_per_day: 1,
    eval_every_hours: 12,
    harness_days: 180,
    gates: {
      max_effective_drift_rate: 0.04,
      min_effective_yield_rate: 0.6,
      max_effective_safety_stop_rate: 0.01
    }
  };
  const src = readJsonSafe(policyPath, {});
  const gatesSrc = src && src.gates && typeof src.gates === 'object'
    ? src.gates
    : {};
  return {
    version: asText(src.version || fallback.version, 40),
    shadow_min_days: Math.max(1, Math.round(toFiniteNumber(src.shadow_min_days, fallback.shadow_min_days))),
    canary_min_days: Math.max(1, Math.round(toFiniteNumber(src.canary_min_days, fallback.canary_min_days))),
    canary_live_fraction: clampNumber(toFiniteNumber(src.canary_live_fraction, fallback.canary_live_fraction), 0.01, 0.5),
    canary_force_low_risk: asBool(src.canary_force_low_risk, fallback.canary_force_low_risk),
    canary_frozen_daily_token_cap: Math.max(200, Math.round(toFiniteNumber(src.canary_frozen_daily_token_cap, fallback.canary_frozen_daily_token_cap))),
    canary_max_runs_per_day: Math.max(1, Math.round(toFiniteNumber(src.canary_max_runs_per_day, fallback.canary_max_runs_per_day))),
    eval_every_hours: Math.max(1, Math.round(toFiniteNumber(src.eval_every_hours, fallback.eval_every_hours))),
    harness_days: Math.max(14, Math.round(toFiniteNumber(src.harness_days, fallback.harness_days))),
    gates: {
      max_effective_drift_rate: clampNumber(
        toFiniteNumber(gatesSrc.max_effective_drift_rate, fallback.gates.max_effective_drift_rate),
        0,
        1
      ),
      min_effective_yield_rate: clampNumber(
        toFiniteNumber(gatesSrc.min_effective_yield_rate, fallback.gates.min_effective_yield_rate),
        0,
        1
      ),
      max_effective_safety_stop_rate: clampNumber(
        toFiniteNumber(gatesSrc.max_effective_safety_stop_rate, fallback.gates.max_effective_safety_stop_rate),
        0,
        1
      )
    }
  };
}

function defaultState(now = nowIso()) {
  return {
    version: '1.0',
    stage: 'shadow',
    stage_since: now,
    last_evaluated_at: null,
    last_eval: null,
    canary_live_fraction_override: null
  };
}

function loadState(statePath = DEFAULT_STATE_PATH, now = nowIso()) {
  const src = readJsonSafe(statePath, null);
  if (!src || typeof src !== 'object') return defaultState(now);
  const out = {
    ...defaultState(now),
    ...src
  };
  out.stage = normalizeStage(out.stage, 'shadow');
  out.stage_since = asText(out.stage_since || now, 80) || now;
  const override = out.canary_live_fraction_override;
  out.canary_live_fraction_override = override == null
    ? null
    : clampNumber(toFiniteNumber(override, 0.15), 0.01, 0.5);
  return out;
}

function saveState(statePath, state) {
  writeJsonAtomic(statePath, state);
}

function randomUnitFromSeed(seed) {
  const hex = crypto
    .createHash('sha256')
    .update(String(seed || ''), 'utf8')
    .digest('hex')
    .slice(0, 13);
  const num = parseInt(hex, 16);
  const denom = 0x1fffffffffffff;
  if (!Number.isFinite(num) || denom <= 0) return 0;
  return clampNumber(num / denom, 0, 1);
}

function decideAction(dateStr, state, policy, now = nowIso()) {
  const stage = normalizeStage(state && state.stage, 'shadow');
  const plan = {
    stage,
    controller_cmd: 'evidence',
    sampled_live: false,
    sample_value: null,
    sample_seed: null,
    env: {}
  } as Record<string, any>;

  if (stage === 'live') {
    plan.controller_cmd = 'run';
    return plan;
  }

  if (stage === 'canary') {
    const bucket = String(now || '').slice(0, 13);
    const seed = `${dateStr}|${bucket}|canary`;
    const sample = randomUnitFromSeed(seed);
    const fraction = clampNumber(
      state && state.canary_live_fraction_override != null
        ? toFiniteNumber(state.canary_live_fraction_override, policy.canary_live_fraction)
        : toFiniteNumber(policy.canary_live_fraction, 0.15),
      0.01,
      0.5
    );
    const sampledLive = sample < fraction;
    plan.sample_value = Number(sample.toFixed(6));
    plan.sample_seed = seed;
    plan.sampled_live = sampledLive;
    plan.controller_cmd = sampledLive ? 'run' : 'evidence';
    if (sampledLive) {
      if (policy.canary_force_low_risk) plan.env.AUTONOMY_ALLOWED_RISKS = 'low';
      plan.env.AUTONOMY_DAILY_TOKEN_CAP = String(policy.canary_frozen_daily_token_cap);
      plan.env.AUTONOMY_MAX_RUNS_PER_DAY = String(policy.canary_max_runs_per_day);
    }
    return plan;
  }

  return plan;
}

function runHarness(endDate, days) {
  const args = [
    HARNESS_SCRIPT,
    'run',
    String(endDate || todayUtc()),
    `--days=${Math.max(14, Number(days || 180))}`,
    '--write=0'
  ];
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const line = stdout.split('\n').find((x) => x.trim().startsWith('{') && x.trim().endsWith('}'));
      if (line) {
        try { payload = JSON.parse(line); } catch {}
      }
    }
  }
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    payload,
    stdout,
    stderr
  };
}

function extractMetrics(harnessPayload) {
  const eff = harnessPayload && harnessPayload.checks_effective && typeof harnessPayload.checks_effective === 'object'
    ? harnessPayload.checks_effective
    : {};
  return {
    effective_drift_rate: toFiniteNumber(eff.drift_rate && eff.drift_rate.value, NaN),
    effective_yield_rate: toFiniteNumber(eff.yield_rate && eff.yield_rate.value, NaN),
    effective_safety_stop_rate: toFiniteNumber(eff.safety_stop_rate && eff.safety_stop_rate.value, NaN)
  };
}

function gateMetrics(metrics, policy) {
  const driftOk = Number.isFinite(metrics.effective_drift_rate)
    && metrics.effective_drift_rate <= policy.gates.max_effective_drift_rate;
  const yieldOk = Number.isFinite(metrics.effective_yield_rate)
    && metrics.effective_yield_rate >= policy.gates.min_effective_yield_rate;
  const safetyOk = Number.isFinite(metrics.effective_safety_stop_rate)
    && metrics.effective_safety_stop_rate <= policy.gates.max_effective_safety_stop_rate;
  return {
    pass: driftOk && yieldOk && safetyOk,
    drift_ok: driftOk,
    yield_ok: yieldOk,
    safety_ok: safetyOk
  };
}

function evaluateTransition(stage, stageDays, gates, policy) {
  const current = normalizeStage(stage, 'shadow');
  if (!gates.pass) {
    if (current === 'live') {
      return { transition: true, to_stage: 'canary', reason: 'gate_fail_live_demote_canary' };
    }
    if (current === 'canary') {
      return { transition: true, to_stage: 'shadow', reason: 'gate_fail_canary_demote_shadow' };
    }
    return { transition: false, to_stage: current, reason: 'shadow_gate_fail_hold' };
  }
  if (current === 'shadow' && stageDays >= policy.shadow_min_days) {
    return { transition: true, to_stage: 'canary', reason: 'shadow_promotion_to_canary' };
  }
  if (current === 'canary' && stageDays >= policy.canary_min_days) {
    return { transition: true, to_stage: 'live', reason: 'canary_promotion_to_live' };
  }
  return { transition: false, to_stage: current, reason: 'hold_stage' };
}

function evaluateRollout(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const ts = nowIso();
  const policyPath = path.resolve(String(o.policyPath || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(o.statePath || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(o.auditPath || DEFAULT_AUDIT_PATH));
  const write = o.write !== false;
  const policy = loadPolicy(policyPath);
  const before = loadState(statePath, ts);
  const endDate = dateArgOrToday(o.endDate);
  const days = Math.max(14, Math.round(toFiniteNumber(o.days, policy.harness_days)));

  const harness = o.harness_payload && typeof o.harness_payload === 'object'
    ? { ok: true, code: 0, payload: o.harness_payload, stdout: '', stderr: '' }
    : runHarness(endDate, days);

  if (!harness.ok || !harness.payload || typeof harness.payload !== 'object') {
    return {
      ok: false,
      ts,
      stage: before.stage,
      state_path: statePath,
      policy_path: policyPath,
      error: 'harness_unavailable',
      harness_code: harness.code,
      harness_error: asText(harness.stderr || harness.stdout || '', 300)
    };
  }

  const metrics = extractMetrics(harness.payload);
  const gates = gateMetrics(metrics, policy);
  const stageDays = daysSince(before.stage_since);
  const stageAgeDays = stageDays == null ? 0 : Number(stageDays.toFixed(3));
  const transition = evaluateTransition(before.stage, stageAgeDays, gates, policy);
  const after = {
    ...before,
    last_evaluated_at: ts,
    last_eval: {
      ts,
      end_date: endDate,
      days,
      metrics,
      gates,
      reason: transition.reason
    }
  };
  if (transition.transition) {
    after.stage = transition.to_stage;
    after.stage_since = ts;
  }

  const out = {
    ok: true,
    ts,
    state_path: statePath,
    policy_path: policyPath,
    write,
    end_date: endDate,
    days,
    before: {
      stage: before.stage,
      stage_since: before.stage_since,
      stage_age_days: stageAgeDays
    },
    after: {
      stage: after.stage,
      stage_since: after.stage_since
    },
    metrics,
    gates,
    transition
  };

  if (write) {
    saveState(statePath, after);
    appendJsonl(auditPath, {
      ts,
      type: 'rollout_evaluate',
      stage_before: before.stage,
      stage_after: after.stage,
      transition: transition.transition === true,
      reason: transition.reason,
      metrics,
      gates,
      end_date: endDate,
      days
    });
  }
  return out;
}

function shouldAutoEvaluate(state, policy) {
  const hrs = hoursSince(state && state.last_evaluated_at);
  if (hrs == null) return true;
  return hrs >= Math.max(1, Number(policy.eval_every_hours || 12));
}

function resolveRolloutPlan(dateStr, opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const policyPath = path.resolve(String(o.policyPath || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(o.statePath || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(o.auditPath || DEFAULT_AUDIT_PATH));
  const policy = loadPolicy(policyPath);
  let state = loadState(statePath);
  let evalResult = null;
  if (o.autoEvaluate !== false && shouldAutoEvaluate(state, policy)) {
    evalResult = evaluateRollout({
      policyPath,
      statePath,
      auditPath,
      endDate: dateArgOrToday(dateStr),
      days: policy.harness_days,
      write: true
    });
    state = loadState(statePath);
  }
  const decision = decideAction(dateArgOrToday(dateStr), state, policy, nowIso());
  return {
    ok: true,
    ts: nowIso(),
    policy_path: policyPath,
    state_path: statePath,
    policy,
    state,
    decision,
    evaluate: evalResult
  };
}

function setStage(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const ts = nowIso();
  const policyPath = path.resolve(String(o.policyPath || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(o.statePath || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(o.auditPath || DEFAULT_AUDIT_PATH));
  const stage = normalizeStage(o.stage, '');
  const note = asText(o.approval_note || o.approvalNote || '', 240);
  if (!stage) {
    return { ok: false, ts, error: 'invalid_stage', expected: ['shadow', 'canary', 'live'] };
  }
  if (note.length < 8) {
    return { ok: false, ts, error: 'approval_note_too_short', min_len: 8 };
  }
  const before = loadState(statePath, ts);
  const after = {
    ...before,
    stage,
    stage_since: ts,
    last_manual_change_at: ts,
    last_manual_change_note: note
  };
  saveState(statePath, after);
  appendJsonl(auditPath, {
    ts,
    type: 'rollout_set_stage',
    stage_before: before.stage,
    stage_after: stage,
    approval_note: note
  });
  return {
    ok: true,
    ts,
    policy_path: policyPath,
    state_path: statePath,
    before: { stage: before.stage, stage_since: before.stage_since },
    after: { stage: after.stage, stage_since: after.stage_since }
  };
}

function status(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const policyPath = path.resolve(String(o.policyPath || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(o.statePath || DEFAULT_STATE_PATH));
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath);
  const plan = decideAction(todayUtc(), state, policy, nowIso());
  return {
    ok: true,
    ts: nowIso(),
    policy_path: policyPath,
    state_path: statePath,
    policy,
    state,
    decision_preview: plan
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autonomy_rollout_controller.js status');
  console.log('  node systems/autonomy/autonomy_rollout_controller.js evaluate [YYYY-MM-DD] [--days=N] [--write=0|1]');
  console.log('  node systems/autonomy/autonomy_rollout_controller.js decide [YYYY-MM-DD]');
  console.log('  node systems/autonomy/autonomy_rollout_controller.js set --stage=shadow|canary|live --approval-note="..."');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  const dateStr = dateArgOrToday(args._[1]);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status(args), null, 2) + '\n');
    return;
  }
  if (cmd === 'evaluate') {
    const write = String(args.write || '1') !== '0';
    const days = args.days != null ? Math.max(14, Math.round(toFiniteNumber(args.days, 180))) : undefined;
    process.stdout.write(JSON.stringify(evaluateRollout({ ...args, endDate: dateStr, days, write }), null, 2) + '\n');
    return;
  }
  if (cmd === 'decide') {
    process.stdout.write(JSON.stringify(resolveRolloutPlan(dateStr, { ...args, autoEvaluate: false }), null, 2) + '\n');
    return;
  }
  if (cmd === 'set') {
    const res = setStage({
      ...args,
      stage: args.stage,
      approval_note: args['approval-note'] || args.approval_note
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    if (!res.ok) process.exit(2);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_AUDIT_PATH,
  loadPolicy,
  loadState,
  saveState,
  decideAction,
  evaluateRollout,
  resolveRolloutPlan,
  setStage,
  status,
  gateMetrics,
  evaluateTransition
};
export {};

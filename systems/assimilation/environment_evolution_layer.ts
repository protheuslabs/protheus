#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.ENV_EVOLUTION_ROOT
  ? path.resolve(process.env.ENV_EVOLUTION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.ENV_EVOLUTION_POLICY_PATH
  ? path.resolve(process.env.ENV_EVOLUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'environment_evolution_layer_policy.json');

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
  console.log('  node systems/assimilation/environment_evolution_layer.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/environment_evolution_layer.js status [--capability-id=<id>] [--policy=<path>]');
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
    schema_id: 'environment_evolution_layer_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    ema_alpha: 0.22,
    robustness_thresholds: {
      strong: 0.7,
      weak: 0.35
    },
    feedback: {
      confidence_shaping_gain: 0.2,
      doctor_on_fail: true,
      min_samples_for_stability: 6
    },
    state: {
      state_path: 'state/assimilation/environment_evolution/state.json',
      latest_path: 'state/assimilation/environment_evolution/latest.json',
      receipts_path: 'state/assimilation/environment_evolution/receipts.jsonl',
      doctor_queue_path: 'state/ops/autotest_doctor/environment_feedback_queue.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.robustness_thresholds && typeof raw.robustness_thresholds === 'object'
    ? raw.robustness_thresholds
    : {};
  const feedback = raw.feedback && typeof raw.feedback === 'object' ? raw.feedback : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    ema_alpha: clampNumber(raw.ema_alpha, 0.01, 1, base.ema_alpha),
    robustness_thresholds: {
      strong: clampNumber(thresholds.strong, 0, 1, base.robustness_thresholds.strong),
      weak: clampNumber(thresholds.weak, 0, 1, base.robustness_thresholds.weak)
    },
    feedback: {
      confidence_shaping_gain: clampNumber(
        feedback.confidence_shaping_gain,
        0,
        1,
        base.feedback.confidence_shaping_gain
      ),
      doctor_on_fail: feedback.doctor_on_fail !== false,
      min_samples_for_stability: clampInt(
        feedback.min_samples_for_stability,
        1,
        1000,
        base.feedback.min_samples_for_stability
      )
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      doctor_queue_path: resolvePath(state.doctor_queue_path || base.state.doctor_queue_path, base.state.doctor_queue_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'environment_evolution_state',
      schema_version: '1.0',
      updated_at: null,
      capabilities: {}
    };
  }
  return {
    schema_id: 'environment_evolution_state',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {}
  };
}

function evaluateEnvironmentEvolution(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'environment_evolution_layer',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160);
  if (!capabilityId) {
    return {
      ok: false,
      type: 'environment_evolution_layer',
      error: 'capability_id_required'
    };
  }

  const outcome = normalizeToken(inputRaw.outcome || 'shadow_only', 80) || 'shadow_only';
  const sourceType = normalizeToken(inputRaw.source_type || 'external_tool', 80) || 'external_tool';
  const observed = outcome === 'success'
    ? 1
    : outcome === 'shadow_only'
      ? 0.55
      : outcome === 'reject'
        ? 0.25
        : 0.1;

  const state = loadState(policy.state.state_path);
  const prev = state.capabilities[capabilityId] && typeof state.capabilities[capabilityId] === 'object'
    ? state.capabilities[capabilityId]
    : {
      samples: 0,
      robustness_score: 0.5,
      success_rate: 0,
      fail_rate: 0,
      source_type: sourceType,
      risk_class: normalizeToken(inputRaw.risk_class || 'general', 64) || 'general'
    };

  const alpha = Number(policy.ema_alpha || 0.22);
  const nextRobustness = clampNumber(
    (alpha * observed) + ((1 - alpha) * Number(prev.robustness_score || 0.5)),
    0,
    1,
    0.5
  );

  const nextSamples = Number(prev.samples || 0) + 1;
  const nextSuccess = Number(prev.success_count || 0) + (outcome === 'success' ? 1 : 0);
  const nextFail = Number(prev.fail_count || 0) + (outcome === 'fail' || outcome === 'reject' ? 1 : 0);
  const successRate = nextSamples > 0 ? Number((nextSuccess / nextSamples).toFixed(6)) : 0;
  const failRate = nextSamples > 0 ? Number((nextFail / nextSamples).toFixed(6)) : 0;

  const confidenceShift = Number((
    (nextRobustness - 0.5)
    * Number(policy.feedback.confidence_shaping_gain || 0.2)
  ).toFixed(6));

  const adaptation = nextRobustness >= Number(policy.robustness_thresholds.strong || 0.7)
    ? 'increase_confidence'
    : nextRobustness <= Number(policy.robustness_thresholds.weak || 0.35)
      ? 'decrease_confidence'
      : 'hold';

  state.capabilities[capabilityId] = {
    capability_id: capabilityId,
    source_type: sourceType,
    risk_class: normalizeToken(inputRaw.risk_class || prev.risk_class || 'general', 64) || 'general',
    samples: nextSamples,
    success_count: nextSuccess,
    fail_count: nextFail,
    success_rate: successRate,
    fail_rate: failRate,
    robustness_score: Number(nextRobustness.toFixed(6)),
    confidence_shift: confidenceShift,
    adaptation,
    updated_at: ts
  };
  state.updated_at = ts;
  writeJsonAtomic(policy.state.state_path, state);

  const shouldDoctorQueue = policy.feedback.doctor_on_fail === true
    && (outcome === 'fail' || outcome === 'reject');
  if (shouldDoctorQueue) {
    appendJsonl(policy.state.doctor_queue_path, {
      ts,
      type: 'environment_feedback_failure',
      capability_id: capabilityId,
      source_type: sourceType,
      outcome,
      robustness_score: Number(nextRobustness.toFixed(6)),
      confidence_shift: confidenceShift,
      recommendation: 'inspect_environment_dependency_or_adapter'
    });
  }

  const out = {
    ok: true,
    type: 'environment_evolution_layer',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    source_type: sourceType,
    outcome,
    samples: nextSamples,
    robustness_score: Number(nextRobustness.toFixed(6)),
    success_rate: successRate,
    fail_rate: failRate,
    confidence_shift: confidenceShift,
    adaptation,
    doctor_feedback_queued: shouldDoctorQueue,
    stable_enough: nextSamples >= Number(policy.feedback.min_samples_for_stability || 6),
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
  const cap = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  const state = loadState(policy.state.state_path);
  if (cap) {
    return {
      ok: true,
      type: 'environment_evolution_status',
      capability_id: cap,
      snapshot: state.capabilities && state.capabilities[cap] ? state.capabilities[cap] : null
    };
  }
  return {
    ok: true,
    type: 'environment_evolution_status',
    latest: readJson(policy.state.latest_path, null),
    tracked_capabilities: Object.keys(state.capabilities || {}).length
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
      const out = evaluateEnvironmentEvolution(input, {
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
      type: 'environment_evolution_layer',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'environment_evolution_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  loadPolicy,
  evaluateEnvironmentEvolution
};

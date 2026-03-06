#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.GENERATIVE_META_MODEL_ROOT
  ? path.resolve(process.env.GENERATIVE_META_MODEL_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.GENERATIVE_META_MODEL_POLICY_PATH
  ? path.resolve(process.env.GENERATIVE_META_MODEL_POLICY_PATH)
  : path.join(ROOT, 'config', 'generative_meta_model_primitive_policy.json');

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
  console.log('  node systems/assimilation/generative_meta_model_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/generative_meta_model_primitive.js status [--policy=<path>]');
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
    schema_id: 'generative_meta_model_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    manifold: {
      ema_alpha: 0.22,
      max_vector_dims: 64,
      max_steering_magnitude: 0.35,
      steering_gain: 0.45
    },
    safety: {
      fluency_floor: 0.58,
      stability_floor: 0.55,
      clamp_distance: 4
    },
    state: {
      manifold_state_path: 'state/assimilation/generative_meta_model/manifold_state.json',
      latest_path: 'state/assimilation/generative_meta_model/latest.json',
      receipts_path: 'state/assimilation/generative_meta_model/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const manifold = raw.manifold && typeof raw.manifold === 'object' ? raw.manifold : {};
  const safety = raw.safety && typeof raw.safety === 'object' ? raw.safety : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    manifold: {
      ema_alpha: clampNumber(manifold.ema_alpha, 0.01, 1, base.manifold.ema_alpha),
      max_vector_dims: clampInt(manifold.max_vector_dims, 4, 4096, base.manifold.max_vector_dims),
      max_steering_magnitude: clampNumber(
        manifold.max_steering_magnitude,
        0,
        2,
        base.manifold.max_steering_magnitude
      ),
      steering_gain: clampNumber(manifold.steering_gain, 0, 2, base.manifold.steering_gain)
    },
    safety: {
      fluency_floor: clampNumber(safety.fluency_floor, 0, 1, base.safety.fluency_floor),
      stability_floor: clampNumber(safety.stability_floor, 0, 1, base.safety.stability_floor),
      clamp_distance: clampNumber(safety.clamp_distance, 0.1, 100, base.safety.clamp_distance)
    },
    state: {
      manifold_state_path: resolvePath(
        state.manifold_state_path || base.state.manifold_state_path,
        base.state.manifold_state_path
      ),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadManifold(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'generative_meta_model_manifold',
      schema_version: '1.0',
      updated_at: null,
      count: 0,
      centroid: []
    };
  }
  return {
    schema_id: 'generative_meta_model_manifold',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    count: clampInt(payload.count, 0, 1000000000, 0),
    centroid: Array.isArray(payload.centroid) ? payload.centroid.map((v: unknown) => clampNumber(v, -100, 100, 0)) : []
  };
}

function buildVector(inputRaw: AnyObj, maxDims: number) {
  const explicit = Array.isArray(inputRaw.activation_vector)
    ? inputRaw.activation_vector
    : [];
  const vector = explicit
    .slice(0, maxDims)
    .map((v: unknown) => clampNumber(v, -100, 100, 0));
  if (vector.length) return vector;

  const contextRows = Array.isArray(inputRaw.context_rows)
    ? inputRaw.context_rows
    : [];
  if (contextRows.length) {
    return contextRows
      .slice(0, maxDims)
      .map((row: unknown, idx: number) => {
        const text = String(row == null ? '' : row);
        const charWeight = Math.min(1, text.length / 280);
        const tokenWeight = Math.min(1, text.split(/\s+/).filter(Boolean).length / 80);
        return Number((charWeight * 0.6 + tokenWeight * 0.4 + (idx * 0.01)).toFixed(6));
      });
  }

  return [
    clampNumber(inputRaw.base_drift, -1, 1, 0),
    clampNumber(inputRaw.base_safety, -1, 1, 0),
    clampNumber(inputRaw.base_yield, -1, 1, 0)
  ];
}

function vectorDistance(a: number[], b: number[], clampDistance: number) {
  const dims = Math.max(a.length, b.length);
  if (dims === 0) return 0;
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    const delta = av - bv;
    sum += delta * delta;
  }
  const dist = Math.sqrt(sum / dims);
  return clampNumber(dist, 0, clampDistance, 0);
}

function runGenerativeMetaModel(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'generative_meta_model_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';
  const vector = buildVector(inputRaw, Number(policy.manifold.max_vector_dims || 64));

  const manifold = loadManifold(policy.state.manifold_state_path);
  const centroidPrev = Array.isArray(manifold.centroid) ? manifold.centroid.slice(0, vector.length) : [];
  while (centroidPrev.length < vector.length) centroidPrev.push(0);

  const alpha = Number(policy.manifold.ema_alpha || 0.22);
  const centroidNext = vector.map((v: number, idx: number) => {
    const prev = Number(centroidPrev[idx] || 0);
    return Number((prev * (1 - alpha) + v * alpha).toFixed(6));
  });

  const distance = vectorDistance(vector, centroidNext, Number(policy.safety.clamp_distance || 4));
  const steeringMagnitude = clampNumber(
    distance * Number(policy.manifold.steering_gain || 0.45),
    0,
    Number(policy.manifold.max_steering_magnitude || 0.35),
    0
  );
  const fluencyScore = clampNumber(1 - (distance / Number(policy.safety.clamp_distance || 4)), 0, 1, 0);
  const stabilityScore = clampNumber(1 - ((distance * 0.9) / Number(policy.safety.clamp_distance || 4)), 0, 1, 0);
  const safeSteering = fluencyScore >= Number(policy.safety.fluency_floor || 0.58)
    && stabilityScore >= Number(policy.safety.stability_floor || 0.55);

  const steeringVector = vector.map((v: number, idx: number) => {
    const delta = v - Number(centroidNext[idx] || 0);
    const clipped = clampNumber(delta, -steeringMagnitude, steeringMagnitude, 0);
    return Number(clipped.toFixed(6));
  });

  manifold.count = clampInt(manifold.count, 0, 1000000000, 0) + 1;
  manifold.centroid = centroidNext;
  manifold.updated_at = ts;

  const out = {
    ok: true,
    type: 'generative_meta_model_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    activation_vector_dims: vector.length,
    manifold_distance: Number(distance.toFixed(6)),
    steering_magnitude: Number(steeringMagnitude.toFixed(6)),
    steering_vector: steeringVector,
    fluency_score: Number(fluencyScore.toFixed(6)),
    stability_score: Number(stabilityScore.toFixed(6)),
    safety: {
      safe_steering: safeSteering,
      fluency_floor: Number(policy.safety.fluency_floor || 0),
      stability_floor: Number(policy.safety.stability_floor || 0)
    },
    state_path: rel(policy.state.manifold_state_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state.manifold_state_path, manifold);
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandRun(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GENERATIVE_META_MODEL_POLICY_PATH || DEFAULT_POLICY_PATH));
  const input = parseJsonArg(args['input-json'] || args.input_json, {});
  return runGenerativeMetaModel(input, {
    policyPath,
    apply: toBool(args.apply, false)
  });
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.GENERATIVE_META_MODEL_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const manifold = loadManifold(policy.state.manifold_state_path);
  const latest = readJson(policy.state.latest_path, null);
  return {
    ok: true,
    type: 'generative_meta_model_status',
    ts: nowIso(),
    manifold_count: manifold.count,
    centroid_dims: Array.isArray(manifold.centroid) ? manifold.centroid.length : 0,
    latest: latest && typeof latest === 'object'
      ? {
        capability_id: latest.capability_id || null,
        manifold_distance: latest.manifold_distance || null,
        safe_steering: !!(latest.safety && latest.safety.safe_steering)
      }
      : null,
    state_path: rel(policy.state.manifold_state_path),
    policy_path: rel(policy.policy_path)
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
      type: 'generative_meta_model_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'run_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  runGenerativeMetaModel,
  commandRun,
  commandStatus,
  loadPolicy
};

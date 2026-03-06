#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.ADAPTIVE_ENSEMBLE_ROUTING_ROOT
  ? path.resolve(process.env.ADAPTIVE_ENSEMBLE_ROUTING_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.ADAPTIVE_ENSEMBLE_ROUTING_POLICY_PATH
  ? path.resolve(process.env.ADAPTIVE_ENSEMBLE_ROUTING_POLICY_PATH)
  : path.join(ROOT, 'config', 'adaptive_ensemble_routing_primitive_policy.json');

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
  console.log('  node systems/assimilation/adaptive_ensemble_routing_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/adaptive_ensemble_routing_primitive.js status [--policy=<path>]');
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
    schema_id: 'adaptive_ensemble_routing_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    routing: {
      min_specialists: 2,
      aligned_weight: 0.56,
      complementary_weight: 0.44,
      uncertainty_bias: 0.65,
      max_selected_specialists: 3
    },
    outputs: {
      emit_weaver_profile: true
    },
    state: {
      latest_path: 'state/assimilation/adaptive_ensemble_routing/latest.json',
      history_path: 'state/assimilation/adaptive_ensemble_routing/history.jsonl',
      receipts_path: 'state/assimilation/adaptive_ensemble_routing/receipts.jsonl',
      weaver_profiles_path: 'state/autonomy/weaver/adaptive_ensemble_profiles.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    routing: {
      min_specialists: clampInt(routing.min_specialists, 1, 64, base.routing.min_specialists),
      aligned_weight: clampNumber(routing.aligned_weight, 0, 1, base.routing.aligned_weight),
      complementary_weight: clampNumber(
        routing.complementary_weight,
        0,
        1,
        base.routing.complementary_weight
      ),
      uncertainty_bias: clampNumber(routing.uncertainty_bias, 0, 1, base.routing.uncertainty_bias),
      max_selected_specialists: clampInt(
        routing.max_selected_specialists,
        1,
        16,
        base.routing.max_selected_specialists
      )
    },
    outputs: {
      emit_weaver_profile: outputs.emit_weaver_profile !== false
    },
    state: {
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      weaver_profiles_path: resolvePath(state.weaver_profiles_path || base.state.weaver_profiles_path, base.state.weaver_profiles_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function scoreSpecialist(row: AnyObj, cfg: AnyObj, uncertaintyScore: number) {
  const confidence = clampNumber(row && row.confidence, 0, 1, 0.5);
  const correction = clampNumber(row && row.error_correction, 0, 1, 0.5);
  const trust = clampNumber(row && row.trust_score, 0, 1, 0.5);
  const mode = normalizeToken(row && row.mode || 'aligned', 32) || 'aligned';
  const alignedWeight = Number(cfg.aligned_weight || 0.56);
  const complementaryWeight = Number(cfg.complementary_weight || 0.44);

  let score = (confidence * 0.55) + (trust * 0.45);
  if (mode === 'aligned') {
    score = score * alignedWeight + ((1 - uncertaintyScore) * 0.1);
  } else {
    score = ((confidence * 0.4) + (correction * 0.4) + (trust * 0.2)) * complementaryWeight
      + (uncertaintyScore * Number(cfg.uncertainty_bias || 0.65) * 0.2);
  }

  return {
    specialist_id: normalizeToken(row && row.specialist_id || row && row.agent_id || 'unknown', 120) || 'unknown',
    mode: mode === 'complementary' ? 'complementary' : 'aligned',
    confidence,
    error_correction: correction,
    trust_score: trust,
    score: Number(clampNumber(score, 0, 1, 0).toFixed(6))
  };
}

function runAdaptiveEnsembleRouting(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'adaptive_ensemble_routing_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';
  const objectiveId = normalizeToken(inputRaw.objective_id || `${capabilityId}_${ts}`, 180);
  const uncertaintyScore = clampNumber(inputRaw.uncertainty_score, 0, 1, 0.4);

  const specialistsRaw = Array.isArray(inputRaw.specialists) ? inputRaw.specialists : [];
  const specialists = specialistsRaw
    .map((row: AnyObj) => scoreSpecialist(row, policy.routing, uncertaintyScore))
    .filter((row: AnyObj) => row.specialist_id !== 'unknown');

  const ranked = specialists
    .slice(0)
    .sort((a: AnyObj, b: AnyObj) => Number(b.score || 0) - Number(a.score || 0));

  const selected = ranked.slice(0, Number(policy.routing.max_selected_specialists || 3));
  const aligned = selected.filter((row: AnyObj) => row.mode === 'aligned');
  const complementary = selected.filter((row: AnyObj) => row.mode === 'complementary');

  const selectedMode = (uncertaintyScore >= 0.55 || complementary.length > aligned.length)
    ? (aligned.length > 0 ? 'blended' : 'complementary')
    : (complementary.length > 0 ? 'blended' : 'aligned');

  const routePlan = {
    selected_mode: selectedMode,
    primary_specialist: selected[0] ? selected[0].specialist_id : null,
    specialist_ids: selected.map((row: AnyObj) => row.specialist_id),
    lane_hint: selectedMode === 'complementary' ? 'error_corrective_lane' : 'trust_building_lane',
    uncertainty_score: Number(uncertaintyScore.toFixed(6))
  };

  const out = {
    ok: true,
    type: 'adaptive_ensemble_routing_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    objective_id: objectiveId,
    specialist_count: specialists.length,
    ranked_specialists: ranked.slice(0, 12),
    route_plan: routePlan,
    weaver_profile: {
      objective_id: objectiveId,
      capability_id: capabilityId,
      selected_mode: routePlan.selected_mode,
      specialist_ids: routePlan.specialist_ids,
      uncertainty_score: routePlan.uncertainty_score
    },
    state_path: rel(policy.state.latest_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.history_path, out);
  appendJsonl(policy.state.receipts_path, out);
  if (policy.outputs.emit_weaver_profile === true) {
    appendJsonl(policy.state.weaver_profiles_path, {
      ts,
      type: 'adaptive_ensemble_profile',
      objective_id: objectiveId,
      capability_id: capabilityId,
      selected_mode: routePlan.selected_mode,
      specialist_ids: routePlan.specialist_ids,
      uncertainty_score: routePlan.uncertainty_score,
      source: 'adaptive_ensemble_routing_primitive'
    });
  }
  return out;
}

function commandRun(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.ADAPTIVE_ENSEMBLE_ROUTING_POLICY_PATH || DEFAULT_POLICY_PATH));
  const input = parseJsonArg(args['input-json'] || args.input_json, {});
  return runAdaptiveEnsembleRouting(input, {
    policyPath,
    apply: toBool(args.apply, false)
  });
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.ADAPTIVE_ENSEMBLE_ROUTING_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.state.latest_path, null);
  return {
    ok: true,
    type: 'adaptive_ensemble_routing_status',
    ts: nowIso(),
    latest: latest && typeof latest === 'object'
      ? {
        capability_id: latest.capability_id || null,
        objective_id: latest.objective_id || null,
        selected_mode: latest.route_plan && latest.route_plan.selected_mode || null
      }
      : null,
    policy_path: rel(policy.policy_path),
    weaver_profiles_path: rel(policy.state.weaver_profiles_path)
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
      type: 'adaptive_ensemble_routing_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'run_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  runAdaptiveEnsembleRouting,
  commandRun,
  commandStatus,
  loadPolicy
};

#!/usr/bin/env node
'use strict';

/**
 * objective_optimization_floor.js
 *
 * Dynamic optimization floor by objective criticality.
 *
 * Usage:
 *   node systems/autonomy/objective_optimization_floor.js run --objective=<id> [--criticality=safety|financial|reliability|standard] [--delta=5.2] [--plateau-streak=3] [--override=0|1]
 *   node systems/autonomy/objective_optimization_floor.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.OBJECTIVE_OPT_FLOOR_POLICY_PATH
  ? path.resolve(process.env.OBJECTIVE_OPT_FLOOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'objective_optimization_floor_policy.json');
const APERTURE_LATEST_PATH = process.env.OBJECTIVE_OPT_APERTURE_LATEST_PATH
  ? path.resolve(process.env.OBJECTIVE_OPT_APERTURE_LATEST_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'optimization_aperture', 'latest.json');
const STATE_DIR = process.env.OBJECTIVE_OPT_FLOOR_STATE_DIR
  ? path.resolve(process.env.OBJECTIVE_OPT_FLOOR_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'objective_optimization_floor');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/objective_optimization_floor.js run --objective=<id> [--criticality=safety|financial|reliability|standard] [--delta=5.2] [--plateau-streak=3] [--override=0|1]');
  console.log('  node systems/autonomy/objective_optimization_floor.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
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

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    criticality_floor_bands: {
      safety: 2,
      financial: 5,
      reliability: 5,
      standard: 10
    },
    aperture_multipliers: {
      tight: 1.2,
      balanced: 1,
      wide: 0.85
    },
    plateau_min_streak: 3,
    objective_criticality_map: {
      T1_make_jay_billionaire_v1: 'financial',
      T1_generational_wealth_v1: 'financial'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const bands = src.criticality_floor_bands && typeof src.criticality_floor_bands === 'object'
    ? src.criticality_floor_bands
    : base.criticality_floor_bands;
  const apertures = src.aperture_multipliers && typeof src.aperture_multipliers === 'object'
    ? src.aperture_multipliers
    : base.aperture_multipliers;
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    criticality_floor_bands: {
      safety: clampNumber(bands.safety, 0.2, 40, base.criticality_floor_bands.safety),
      financial: clampNumber(bands.financial, 0.2, 40, base.criticality_floor_bands.financial),
      reliability: clampNumber(bands.reliability, 0.2, 40, base.criticality_floor_bands.reliability),
      standard: clampNumber(bands.standard, 0.2, 60, base.criticality_floor_bands.standard)
    },
    aperture_multipliers: {
      tight: clampNumber(apertures.tight, 0.3, 3, base.aperture_multipliers.tight),
      balanced: clampNumber(apertures.balanced, 0.3, 3, base.aperture_multipliers.balanced),
      wide: clampNumber(apertures.wide, 0.3, 3, base.aperture_multipliers.wide)
    },
    plateau_min_streak: clampInt(src.plateau_min_streak, 1, 30, base.plateau_min_streak),
    objective_criticality_map: src.objective_criticality_map && typeof src.objective_criticality_map === 'object'
      ? src.objective_criticality_map
      : base.objective_criticality_map
  };
}

function resolveCriticality(policy, objectiveId, explicitCriticality) {
  const explicit = normalizeToken(explicitCriticality, 32);
  if (['safety', 'financial', 'reliability', 'standard'].includes(explicit)) return explicit;
  const byMap = policy.objective_criticality_map && typeof policy.objective_criticality_map === 'object'
    ? normalizeToken(policy.objective_criticality_map[objectiveId], 32)
    : '';
  if (['safety', 'financial', 'reliability', 'standard'].includes(byMap)) return byMap;
  return 'standard';
}

function resolveApertureLevel(explicitLevel) {
  const level = normalizeToken(explicitLevel, 32);
  if (['tight', 'balanced', 'wide'].includes(level)) return level;
  const latest = readJson(APERTURE_LATEST_PATH, null);
  const fromState = latest
    && latest.decision
    && typeof latest.decision === 'object'
    ? normalizeToken(latest.decision.level, 32)
    : '';
  if (['tight', 'balanced', 'wide'].includes(fromState)) return fromState;
  return 'balanced';
}

function computeFloorDecision(args, policy) {
  const objectiveId = normalizeText(args.objective || args.id || '', 160);
  const criticality = resolveCriticality(policy, objectiveId, args.criticality);
  const apertureLevel = resolveApertureLevel(args.aperture_level || args.apertureLevel);
  const delta = clampNumber(args.delta, -100, 100, 0);
  const plateauStreak = clampInt(args['plateau-streak'] || args.plateau_streak, 0, 999, 0);
  const override = toBool(args.override, false);

  const baseFloor = Number(policy.criticality_floor_bands[criticality] || policy.criticality_floor_bands.standard || 10);
  const apertureMultiplier = Number(policy.aperture_multipliers[apertureLevel] || policy.aperture_multipliers.balanced || 1);
  const effectiveFloor = Number((baseFloor * apertureMultiplier).toFixed(3));
  const streakMin = Number(policy.plateau_min_streak || 3);

  const goodEnough = !override
    && plateauStreak >= streakMin
    && Number(delta) < effectiveFloor;

  const reasons = [];
  if (override) reasons.push('override_forced_continue');
  if (plateauStreak < streakMin) reasons.push('plateau_streak_below_min');
  if (Number(delta) >= effectiveFloor) reasons.push('delta_above_floor');
  if (goodEnough) reasons.push('optimization_good_enough');

  return {
    objective_id: objectiveId || null,
    criticality,
    aperture_level: apertureLevel,
    base_floor_percent: Number(baseFloor.toFixed(3)),
    aperture_multiplier: Number(apertureMultiplier.toFixed(3)),
    effective_floor_percent: effectiveFloor,
    observed_delta_percent: Number(delta.toFixed(3)),
    plateau_streak: plateauStreak,
    plateau_min_streak: streakMin,
    override,
    good_enough: goodEnough,
    reasons
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const out = {
    ok: true,
    type: 'objective_optimization_floor_decision',
    ts: nowIso(),
    policy_version: policy.version,
    decision: computeFloorDecision(args, policy)
  };
  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(HISTORY_PATH, out);
  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdStatus() {
  const latest = readJson(LATEST_PATH, null);
  if (!latest) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'objective_floor_state_missing',
      latest_path: relPath(LATEST_PATH)
    }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'objective_optimization_floor_status',
    ts: nowIso(),
    latest_path: relPath(LATEST_PATH),
    history_path: relPath(HISTORY_PATH),
    latest
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  resolveCriticality,
  computeFloorDecision
};
export {};

#!/usr/bin/env node
'use strict';

/**
 * optimization_aperture_controller.js
 *
 * Risk-adaptive optimization aperture sensing controller.
 * Computes per-lane optimization aperture from directive risk context.
 *
 * Usage:
 *   node systems/autonomy/optimization_aperture_controller.js run [--lane=autonomy] [--risk=low|medium|high] [--impact=low|medium|high] [--budget-pressure=low|medium|high|critical] [--safety-critical=0|1] [--verification-pass-rate=0.8] [--drift-rate=0.03]
 *   node systems/autonomy/optimization_aperture_controller.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.OPTIMIZATION_APERTURE_POLICY_PATH
  ? path.resolve(process.env.OPTIMIZATION_APERTURE_POLICY_PATH)
  : path.join(ROOT, 'config', 'optimization_aperture_policy.json');
const STATE_DIR = process.env.OPTIMIZATION_APERTURE_STATE_DIR
  ? path.resolve(process.env.OPTIMIZATION_APERTURE_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'optimization_aperture');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/optimization_aperture_controller.js run [--lane=autonomy] [--risk=low|medium|high] [--impact=low|medium|high] [--budget-pressure=low|medium|high|critical] [--safety-critical=0|1] [--verification-pass-rate=0.8] [--drift-rate=0.03]');
  console.log('  node systems/autonomy/optimization_aperture_controller.js status');
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
    strict_default: false,
    target_drift_rate: 0.03,
    score_floor: 0.05,
    score_ceiling: 1,
    penalties: {
      risk: { low: 0.05, medium: 0.22, high: 0.42 },
      impact: { low: 0.02, medium: 0.1, high: 0.2 },
      budget_pressure: { low: 0.02, medium: 0.1, high: 0.2, critical: 0.32 },
      safety_critical: 0.2,
      drift_multiplier: 4
    },
    rewards: {
      verification_pass_rate_multiplier: 0.4
    },
    level_thresholds: {
      tight_max: 0.35,
      balanced_max: 0.7
    },
    lane_defaults: {
      autonomy: { exploration_fraction: 0.2 },
      routing: { exploration_fraction: 0.12 },
      dreams: { exploration_fraction: 0.16 },
      reflex: { exploration_fraction: 0.08 }
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const penalties = src.penalties && typeof src.penalties === 'object' ? src.penalties : {};
  const rewards = src.rewards && typeof src.rewards === 'object' ? src.rewards : {};
  const levels = src.level_thresholds && typeof src.level_thresholds === 'object' ? src.level_thresholds : {};
  const laneDefaults = src.lane_defaults && typeof src.lane_defaults === 'object' ? src.lane_defaults : base.lane_defaults;

  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default === true,
    target_drift_rate: clampNumber(src.target_drift_rate, 0, 1, base.target_drift_rate),
    score_floor: clampNumber(src.score_floor, 0, 1, base.score_floor),
    score_ceiling: clampNumber(src.score_ceiling, 0, 1, base.score_ceiling),
    penalties: {
      risk: {
        low: clampNumber(penalties.risk && penalties.risk.low, 0, 1, base.penalties.risk.low),
        medium: clampNumber(penalties.risk && penalties.risk.medium, 0, 1, base.penalties.risk.medium),
        high: clampNumber(penalties.risk && penalties.risk.high, 0, 1, base.penalties.risk.high)
      },
      impact: {
        low: clampNumber(penalties.impact && penalties.impact.low, 0, 1, base.penalties.impact.low),
        medium: clampNumber(penalties.impact && penalties.impact.medium, 0, 1, base.penalties.impact.medium),
        high: clampNumber(penalties.impact && penalties.impact.high, 0, 1, base.penalties.impact.high)
      },
      budget_pressure: {
        low: clampNumber(penalties.budget_pressure && penalties.budget_pressure.low, 0, 1, base.penalties.budget_pressure.low),
        medium: clampNumber(penalties.budget_pressure && penalties.budget_pressure.medium, 0, 1, base.penalties.budget_pressure.medium),
        high: clampNumber(penalties.budget_pressure && penalties.budget_pressure.high, 0, 1, base.penalties.budget_pressure.high),
        critical: clampNumber(penalties.budget_pressure && penalties.budget_pressure.critical, 0, 1, base.penalties.budget_pressure.critical)
      },
      safety_critical: clampNumber(penalties.safety_critical, 0, 1, base.penalties.safety_critical),
      drift_multiplier: clampNumber(penalties.drift_multiplier, 0, 20, base.penalties.drift_multiplier)
    },
    rewards: {
      verification_pass_rate_multiplier: clampNumber(
        rewards.verification_pass_rate_multiplier,
        0,
        2,
        base.rewards.verification_pass_rate_multiplier
      )
    },
    level_thresholds: {
      tight_max: clampNumber(levels.tight_max, 0.05, 0.95, base.level_thresholds.tight_max),
      balanced_max: clampNumber(levels.balanced_max, 0.1, 0.99, base.level_thresholds.balanced_max)
    },
    lane_defaults: laneDefaults
  };
}

function pickBandPenalty(map, key, fallbackKey = 'medium') {
  const k = normalizeToken(key, 32) || fallbackKey;
  if (Object.prototype.hasOwnProperty.call(map, k)) return Number(map[k] || 0);
  return Number(map[fallbackKey] || 0);
}

function computeAperture(input, policy) {
  const lane = normalizeToken(input.lane || 'autonomy', 64) || 'autonomy';
  const risk = normalizeToken(input.risk || 'medium', 32) || 'medium';
  const impact = normalizeToken(input.impact || 'medium', 32) || 'medium';
  const budgetPressure = normalizeToken(input.budget_pressure || input.budgetPressure || 'medium', 32) || 'medium';
  const safetyCritical = toBool(input.safety_critical, false);
  const verificationPassRate = clampNumber(input.verification_pass_rate, 0, 1, 0.8);
  const driftRate = clampNumber(input.drift_rate, 0, 1, policy.target_drift_rate);

  const riskPenalty = pickBandPenalty(policy.penalties.risk, risk, 'medium');
  const impactPenalty = pickBandPenalty(policy.penalties.impact, impact, 'medium');
  const budgetPenalty = pickBandPenalty(policy.penalties.budget_pressure, budgetPressure, 'medium');
  const safetyPenalty = safetyCritical ? Number(policy.penalties.safety_critical || 0) : 0;
  const driftPenalty = Math.max(0, (driftRate - policy.target_drift_rate) * Number(policy.penalties.drift_multiplier || 0));
  const verificationReward = Math.max(0, verificationPassRate - 0.75) * Number(policy.rewards.verification_pass_rate_multiplier || 0);

  const score = clampNumber(
    1 - riskPenalty - impactPenalty - budgetPenalty - safetyPenalty - driftPenalty + verificationReward,
    Number(policy.score_floor || 0.05),
    Number(policy.score_ceiling || 1),
    Number(policy.score_floor || 0.05)
  );

  const level = score <= Number(policy.level_thresholds.tight_max || 0.35)
    ? 'tight'
    : (score <= Number(policy.level_thresholds.balanced_max || 0.7) ? 'balanced' : 'wide');

  const laneDefaults = policy.lane_defaults && policy.lane_defaults[lane] && typeof policy.lane_defaults[lane] === 'object'
    ? policy.lane_defaults[lane]
    : {};
  const baseExplore = clampNumber(laneDefaults.exploration_fraction, 0, 1, 0.15);
  const levelFactor = level === 'tight' ? 0.45 : (level === 'balanced' ? 1 : 1.55);

  const recommendations = {
    exploration_fraction: Number(clampNumber(baseExplore * levelFactor, 0.01, 0.5, baseExplore).toFixed(4)),
    min_delta_multiplier: Number((level === 'tight' ? 1.2 : (level === 'balanced' ? 1 : 0.85)).toFixed(3)),
    mutation_rate_multiplier: Number((level === 'tight' ? 0.6 : (level === 'balanced' ? 1 : 1.25)).toFixed(3)),
    canary_fraction: Number((level === 'tight' ? 0.05 : (level === 'balanced' ? 0.12 : 0.2)).toFixed(3))
  };

  return {
    lane,
    level,
    score: Number(score.toFixed(4)),
    inputs: {
      risk,
      impact,
      budget_pressure: budgetPressure,
      safety_critical: safetyCritical,
      verification_pass_rate: Number(verificationPassRate.toFixed(4)),
      drift_rate: Number(driftRate.toFixed(6))
    },
    penalties: {
      risk: Number(riskPenalty.toFixed(4)),
      impact: Number(impactPenalty.toFixed(4)),
      budget_pressure: Number(budgetPenalty.toFixed(4)),
      safety_critical: Number(safetyPenalty.toFixed(4)),
      drift: Number(driftPenalty.toFixed(4))
    },
    reward: {
      verification_pass_rate: Number(verificationReward.toFixed(4))
    },
    recommendations
  };
}

function cmdRun(args) {
  const policy = loadPolicy();
  const out = {
    ok: true,
    type: 'optimization_aperture_decision',
    ts: nowIso(),
    policy_version: policy.version,
    decision: computeAperture(args, policy)
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
      error: 'aperture_state_missing',
      latest_path: relPath(LATEST_PATH)
    }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'optimization_aperture_status',
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
  computeAperture
};
export {};

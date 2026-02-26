#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/fractal/regime_organ.js
 *
 * V2-046 Regime Organ.
 * Classifies current operating regime from runtime + trit + resource signals,
 * applies hysteresis/cooldown, and emits bounded proposal-only morph actions.
 *
 * Usage:
 *   node systems/fractal/regime_organ.js run [YYYY-MM-DD] [--policy=path] [--max-actions=6]
 *   node systems/fractal/regime_organ.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadIdentityContext,
  evaluateMorphActions,
  writeIdentityReceipt
} = require('../identity/identity_anchor');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'regime_organ_policy.json');

const REGIME_DIR = process.env.FRACTAL_REGIME_DIR
  ? path.resolve(process.env.FRACTAL_REGIME_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'regime');
const REGIME_LATEST_PATH = path.join(REGIME_DIR, 'latest.json');
const REGIME_STATE_PATH = path.join(REGIME_DIR, 'state.json');

const RUNS_DIR = process.env.FRACTAL_REGIME_RUNS_DIR
  ? path.resolve(process.env.FRACTAL_REGIME_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const SIM_DIR = process.env.FRACTAL_REGIME_SIM_DIR
  ? path.resolve(process.env.FRACTAL_REGIME_SIM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const QUEUE_PATH = process.env.FRACTAL_REGIME_QUEUE_PATH
  ? path.resolve(process.env.FRACTAL_REGIME_QUEUE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'sensory_queue.json');
const AUTOPAUSE_PATH = process.env.FRACTAL_REGIME_AUTOPAUSE_PATH
  ? path.resolve(process.env.FRACTAL_REGIME_AUTOPAUSE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
const TERNARY_DIR = process.env.FRACTAL_REGIME_TERNARY_DIR
  ? path.resolve(process.env.FRACTAL_REGIME_TERNARY_DIR)
  : path.join(ROOT, 'state', 'spine', 'ternary_belief');

const REGIME_ORDER = [
  'throughput',
  'quality',
  'recovery',
  'exploration',
  'constrained_budget'
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/regime_organ.js run [YYYY-MM-DD] [--policy=path] [--max-actions=6]');
  console.log('  node systems/fractal/regime_organ.js status [YYYY-MM-DD|latest]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${String(dateStr || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return String(dateStr || '').slice(0, 10);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
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

function clamp01(v, fallback = 0) {
  return clampNumber(v, 0, 1, fallback);
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseTsMs(v) {
  const ts = Date.parse(String(v || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function addMinutes(isoTs, minutes) {
  const base = parseTsMs(isoTs);
  if (!base) return null;
  return new Date(base + Math.max(0, Number(minutes || 0)) * 60 * 1000).toISOString();
}

function stableId(seed, prefix = 'reg') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_confidence: 0.58,
    max_actions: 4,
    max_magnitude: 0.4,
    hysteresis: {
      switch_margin: 0.12,
      min_dwell_minutes: 180,
      cooldown_minutes: 120
    },
    non_regression: {
      enabled: true,
      require_simulation: false,
      max_drift_regression: 0.004,
      max_yield_regression: 0.02
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const hysteresis = raw.hysteresis && typeof raw.hysteresis === 'object'
    ? raw.hysteresis
    : {};
  const nonRegression = raw.non_regression && typeof raw.non_regression === 'object'
    ? raw.non_regression
    : {};

  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    min_confidence: clampNumber(raw.min_confidence, 0, 1, base.min_confidence),
    max_actions: clampInt(raw.max_actions, 1, 20, base.max_actions),
    max_magnitude: clampNumber(raw.max_magnitude, 0.05, 1, base.max_magnitude),
    hysteresis: {
      switch_margin: clampNumber(hysteresis.switch_margin, 0, 1, base.hysteresis.switch_margin),
      min_dwell_minutes: clampInt(hysteresis.min_dwell_minutes, 0, 7 * 24 * 60, base.hysteresis.min_dwell_minutes),
      cooldown_minutes: clampInt(hysteresis.cooldown_minutes, 0, 7 * 24 * 60, base.hysteresis.cooldown_minutes)
    },
    non_regression: {
      enabled: nonRegression.enabled !== false,
      require_simulation: nonRegression.require_simulation === true,
      max_drift_regression: clampNumber(
        nonRegression.max_drift_regression,
        0,
        0.5,
        base.non_regression.max_drift_regression
      ),
      max_yield_regression: clampNumber(
        nonRegression.max_yield_regression,
        0,
        0.5,
        base.non_regression.max_yield_regression
      )
    }
  };
}

function objectiveFromRuns(dateStr) {
  const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  const counts = {};
  for (const row of rows) {
    if (String(row && row.type || '') !== 'autonomy_run') continue;
    const objective = String(
      row.objective_id
      || (row.directive_pulse && row.directive_pulse.objective_id)
      || (row.objective_binding && row.objective_binding.objective_id)
      || ''
    ).trim();
    if (!objective) continue;
    counts[objective] = Number(counts[objective] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]));
  return ranked.length ? String(ranked[0][0]) : null;
}

function queueSnapshot() {
  const q = readJson(QUEUE_PATH, {});
  const pending = safeNumber(q && q.pending, 0);
  const total = Math.max(pending, safeNumber(q && q.total, pending));
  const ratio = total > 0 ? pending / total : 0;
  let pressure = 'normal';
  if (ratio >= 0.7 || pending >= 80) pressure = 'critical';
  else if (ratio >= 0.45 || pending >= 45) pressure = 'high';
  else if (ratio >= 0.25 || pending >= 20) pressure = 'elevated';
  return {
    pending,
    total,
    pending_ratio: Number(ratio.toFixed(4)),
    pressure
  };
}

function runMetrics(dateStr) {
  const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  let runs = 0;
  let noProgress = 0;
  let policyHolds = 0;
  let safetyStops = 0;

  for (const row of rows) {
    if (String(row && row.type || '') !== 'autonomy_run') continue;
    runs += 1;
    const result = String(row && row.result || '').trim().toLowerCase();
    const outcome = String(row && row.outcome || '').trim().toLowerCase();

    if (outcome === 'no_change') noProgress += 1;
    if (result === 'policy_hold' || result.startsWith('no_candidates_policy_')) policyHolds += 1;
    if (result.startsWith('stop_') || result === 'safety_stop') safetyStops += 1;
  }

  const div = runs > 0 ? runs : 1;
  return {
    runs,
    no_progress: noProgress,
    policy_holds: policyHolds,
    safety_stops: safetyStops,
    no_progress_rate: Number((noProgress / div).toFixed(4)),
    policy_hold_rate: Number((policyHolds / div).toFixed(4)),
    safety_stop_rate: Number((safetyStops / div).toFixed(4))
  };
}

function simulationForDate(dateStr) {
  const fp = path.join(SIM_DIR, `${dateStr}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    return { available: false, drift: null, yield_rate: null };
  }
  const eff = payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : {};
  const raw = payload.checks && typeof payload.checks === 'object'
    ? payload.checks
    : {};
  const driftEffective = Number(eff.drift_rate && eff.drift_rate.value);
  const yieldEffective = Number(eff.yield_rate && eff.yield_rate.value);
  const driftRaw = Number(raw.drift_rate && raw.drift_rate.value);
  const yieldRaw = Number(raw.yield_rate && raw.yield_rate.value);

  const drift = Number.isFinite(driftEffective) ? driftEffective : driftRaw;
  const yieldRate = Number.isFinite(yieldEffective) ? yieldEffective : yieldRaw;

  return {
    available: Number.isFinite(drift) || Number.isFinite(yieldRate),
    drift: Number.isFinite(drift) ? Number(drift.toFixed(6)) : null,
    yield_rate: Number.isFinite(yieldRate) ? Number(yieldRate.toFixed(6)) : null
  };
}

function autopauseSnapshot() {
  const row = readJson(AUTOPAUSE_PATH, {});
  return {
    active: row && row.active === true,
    source: String(row && row.source || '').trim() || null,
    reason: String(row && row.reason || '').trim() || null
  };
}

function ternarySnapshot(dateStr) {
  const dailyPath = path.join(TERNARY_DIR, `${dateStr}_daily.json`);
  const eyesPath = path.join(TERNARY_DIR, `${dateStr}_eyes.json`);
  const payload = readJson(dailyPath, null) || readJson(eyesPath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      trit: 0,
      score: 0,
      confidence: 0,
      snapshot_path: null
    };
  }
  const summary = payload.summary && typeof payload.summary === 'object'
    ? payload.summary
    : {};
  const trit = safeNumber(summary.trit, 0);
  const score = safeNumber(summary.score, 0);
  const confidence = clamp01(summary.confidence, 0);

  return {
    available: true,
    trit: trit > 0 ? 1 : (trit < 0 ? -1 : 0),
    score: Number(score.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    snapshot_path: fs.existsSync(dailyPath)
      ? relPath(dailyPath)
      : (fs.existsSync(eyesPath) ? relPath(eyesPath) : null)
  };
}

function computeRegimeScores(ctx) {
  const queueNorm = clamp01(ctx.queue.pending_ratio, 0);
  const driftNorm = ctx.sim.drift == null
    ? 0.5
    : clamp01((safeNumber(ctx.sim.drift, 0) - 0.02) / 0.05, 0);
  const yieldRate = ctx.sim.yield_rate == null ? 0.68 : safeNumber(ctx.sim.yield_rate, 0.68);
  const yieldPenalty = clamp01((0.72 - yieldRate) / 0.32, 0);
  const noProgressNorm = clamp01(ctx.runs.no_progress_rate, 0);
  const policyHoldNorm = clamp01(ctx.runs.policy_hold_rate, 0);
  const safetyNorm = clamp01(ctx.runs.safety_stop_rate * 4, ctx.runs.safety_stops > 0 ? 1 : 0);
  const budgetNorm = ctx.autopause.active ? 1 : (ctx.queue.pressure === 'critical' ? 0.35 : 0.05);

  const tritNegative = ctx.trit.trit < 0
    ? clamp01(Math.abs(ctx.trit.score) * Math.max(0.4, ctx.trit.confidence), 0.5)
    : 0;
  const uncertainty = ctx.trit.available
    ? clamp01((1 - Math.abs(ctx.trit.score)) * Math.max(0.35, ctx.trit.confidence), 0.5)
    : 0.5;

  const qualityStress = clamp01(
    (0.45 * driftNorm)
    + (0.3 * noProgressNorm)
    + (0.25 * policyHoldNorm),
    0
  );

  return {
    throughput: Number(clamp01(
      (0.55 * queueNorm)
      + (0.25 * yieldPenalty)
      + (0.2 * (1 - qualityStress))
      - (0.35 * budgetNorm),
      0
    ).toFixed(6)),
    quality: Number(clamp01(
      (0.5 * driftNorm)
      + (0.25 * noProgressNorm)
      + (0.15 * policyHoldNorm)
      + (0.1 * safetyNorm),
      0
    ).toFixed(6)),
    recovery: Number(clamp01(
      (0.6 * safetyNorm)
      + (0.25 * tritNegative)
      + (0.15 * policyHoldNorm),
      0
    ).toFixed(6)),
    exploration: Number(clamp01(
      (0.35 * (1 - queueNorm))
      + (0.25 * (1 - qualityStress))
      + (0.2 * clamp01(yieldRate, 0.5))
      + (0.2 * uncertainty)
      - (0.25 * budgetNorm),
      0
    ).toFixed(6)),
    constrained_budget: Number(clamp01(
      (0.7 * budgetNorm)
      + (0.2 * queueNorm)
      + (0.1 * yieldPenalty),
      0
    ).toFixed(6))
  };
}

function pickCandidate(scores) {
  const rows = REGIME_ORDER
    .map((regime, idx) => ({ regime, idx, score: safeNumber(scores && scores[regime], 0) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });

  const top = rows[0] || { regime: 'throughput', score: 0 };
  const second = rows[1] || { regime: top.regime, score: 0 };
  const margin = Math.max(0, top.score - second.score);
  const confidence = clamp01(
    0.42 + (top.score * 0.38) + (margin * 0.4),
    0.45
  );
  return {
    candidate_regime: top.regime,
    candidate_score: Number(top.score.toFixed(6)),
    second_score: Number(second.score.toFixed(6)),
    margin: Number(margin.toFixed(6)),
    confidence: Number(confidence.toFixed(6))
  };
}

function resolveRegimeSelection(policy, state, pick, scores) {
  const now = nowIso();
  const prevActive = REGIME_ORDER.includes(String(state && state.active_regime || ''))
    ? String(state.active_regime)
    : null;

  if (!prevActive) {
    return {
      selected_regime: pick.candidate_regime,
      switched: true,
      reason: 'initial_assignment',
      active_since: now,
      last_switch_ts: now,
      cooldown_until: addMinutes(now, policy.hysteresis.cooldown_minutes)
    };
  }

  if (pick.candidate_regime === prevActive) {
    return {
      selected_regime: prevActive,
      switched: false,
      reason: 'candidate_matches_active',
      active_since: String(state.active_since || now),
      last_switch_ts: String(state.last_switch_ts || state.active_since || now),
      cooldown_until: String(state.cooldown_until || '') || null
    };
  }

  if (pick.confidence < policy.min_confidence) {
    return {
      selected_regime: prevActive,
      switched: false,
      reason: 'confidence_gate',
      active_since: String(state.active_since || now),
      last_switch_ts: String(state.last_switch_ts || state.active_since || now),
      cooldown_until: String(state.cooldown_until || '') || null
    };
  }

  const dwellMinutes = Math.max(
    0,
    Math.floor((parseTsMs(now) - parseTsMs(state && state.active_since)) / (60 * 1000))
  );
  if (dwellMinutes < policy.hysteresis.min_dwell_minutes) {
    return {
      selected_regime: prevActive,
      switched: false,
      reason: 'min_dwell_not_met',
      active_since: String(state.active_since || now),
      last_switch_ts: String(state.last_switch_ts || state.active_since || now),
      cooldown_until: String(state.cooldown_until || '') || null
    };
  }

  const cooldownUntilMs = parseTsMs(state && state.cooldown_until);
  const nowMs = parseTsMs(now);
  if (cooldownUntilMs > nowMs) {
    return {
      selected_regime: prevActive,
      switched: false,
      reason: 'cooldown_active',
      active_since: String(state.active_since || now),
      last_switch_ts: String(state.last_switch_ts || state.active_since || now),
      cooldown_until: String(state.cooldown_until || '') || null
    };
  }

  const activeScore = safeNumber(scores && scores[prevActive], 0);
  const margin = Number((pick.candidate_score - activeScore).toFixed(6));
  if (margin < policy.hysteresis.switch_margin) {
    return {
      selected_regime: prevActive,
      switched: false,
      reason: 'hysteresis_margin',
      active_since: String(state.active_since || now),
      last_switch_ts: String(state.last_switch_ts || state.active_since || now),
      cooldown_until: String(state.cooldown_until || '') || null
    };
  }

  return {
    selected_regime: pick.candidate_regime,
    switched: true,
    reason: 'switch_conditions_met',
    active_since: now,
    last_switch_ts: now,
    cooldown_until: addMinutes(now, policy.hysteresis.cooldown_minutes)
  };
}

function buildActions(dateStr, objectiveId, selectedRegime, policy, maxActions) {
  const cap = Math.max(1, Math.min(maxActions, policy.max_actions));
  const mag = clampNumber(policy.max_magnitude, 0.05, 1, 0.4);

  const templates = {
    throughput: [
      { kind: 'rewire', target: 'queue->spawn_broker', reason: 'increase parallel fulfillment under queue pressure', risk: 'medium', magnitude: mag },
      { kind: 'reprioritize', target: 'lane:delivery', reason: 'prioritize high-value backlog completion throughput', risk: 'low', magnitude: Math.min(mag, 0.35) },
      { kind: 'spawn', target: 'module:throughput_router', reason: 'add bounded routing assist for high-pending windows', risk: 'low', magnitude: Math.min(mag, 0.3) }
    ],
    quality: [
      { kind: 'spawn', target: 'module:quality_guardrail_assistant', reason: 'elevated drift/no-progress requires stronger validation', risk: 'low', magnitude: Math.min(mag, 0.3) },
      { kind: 'prune', target: 'lane:high_risk_exploration', reason: 'reduce low-confidence exploration while quality pressure is high', risk: 'low', magnitude: Math.min(mag, 0.28) },
      { kind: 'reprioritize', target: 'lane:verification', reason: 'prioritize verification and deterministic checks', risk: 'low', magnitude: Math.min(mag, 0.34) }
    ],
    recovery: [
      { kind: 'rewire', target: 'execution->safe_mode', reason: 'safety-stop/failure pressure requires recovery-first routing', risk: 'medium', magnitude: Math.min(mag, 0.36) },
      { kind: 'spawn', target: 'module:failure_recovery_watch', reason: 'add bounded recovery monitor with escalation receipts', risk: 'low', magnitude: Math.min(mag, 0.28) },
      { kind: 'prune', target: 'lane:aggressive_autonomy', reason: 'reduce aggressive lanes during recovery windows', risk: 'medium', magnitude: Math.min(mag, 0.32) }
    ],
    exploration: [
      { kind: 'spawn', target: 'module:hypothesis_probe_lane', reason: 'low pressure + uncertainty supports controlled exploration', risk: 'low', magnitude: Math.min(mag, 0.3) },
      { kind: 'rewire', target: 'strategy->evolution_arena', reason: 'route bounded experiments to sandboxed arena', risk: 'low', magnitude: Math.min(mag, 0.27) },
      { kind: 'reprioritize', target: 'lane:novelty_sampling', reason: 'increase novelty sampling under healthy system conditions', risk: 'low', magnitude: Math.min(mag, 0.33) }
    ],
    constrained_budget: [
      { kind: 'prune', target: 'lane:high_cost_routes', reason: 'budget pressure requires cost shedding and route contraction', risk: 'low', magnitude: Math.min(mag, 0.38) },
      { kind: 'rewire', target: 'routing->local_first', reason: 'bias toward local/low-burn routes while constrained', risk: 'low', magnitude: Math.min(mag, 0.34) },
      { kind: 'reprioritize', target: 'lane:cost_efficiency', reason: 'prioritize high value-per-token activity until pressure clears', risk: 'low', magnitude: Math.min(mag, 0.36) }
    ]
  };

  const rows = Array.isArray(templates[selectedRegime])
    ? templates[selectedRegime]
    : templates.throughput;

  return rows.slice(0, cap).map((row, idx) => ({
    id: stableId(`${dateStr}|${objectiveId || ''}|${selectedRegime}|${idx}|${row.kind}|${row.target}`, 'rga'),
    kind: row.kind,
    target: row.target,
    reason: row.reason,
    risk: row.risk,
    ttl_hours: selectedRegime === 'recovery' ? 12 : 24,
    magnitude: Number(clamp01(row.magnitude, 0.2).toFixed(4))
  }));
}

function evaluateNonRegression(dateStr, policy) {
  if (!policy.non_regression.enabled) {
    return {
      pass: true,
      reason: 'disabled',
      current_date: dateStr,
      baseline_date: null
    };
  }

  const current = simulationForDate(dateStr);
  if (!current.available) {
    return {
      pass: !policy.non_regression.require_simulation,
      reason: policy.non_regression.require_simulation ? 'missing_current_simulation' : 'missing_current_simulation_optional',
      current_date: dateStr,
      baseline_date: null,
      current_drift: current.drift,
      current_yield_rate: current.yield_rate
    };
  }

  const baselineDate = shiftDate(dateStr, -1);
  const baseline = simulationForDate(baselineDate);
  if (!baseline.available) {
    return {
      pass: true,
      reason: 'baseline_missing',
      current_date: dateStr,
      baseline_date: baselineDate,
      current_drift: current.drift,
      current_yield_rate: current.yield_rate,
      baseline_drift: baseline.drift,
      baseline_yield_rate: baseline.yield_rate
    };
  }

  const driftDelta = (current.drift == null || baseline.drift == null)
    ? null
    : Number((current.drift - baseline.drift).toFixed(6));
  const yieldDelta = (current.yield_rate == null || baseline.yield_rate == null)
    ? null
    : Number((baseline.yield_rate - current.yield_rate).toFixed(6));

  const driftOk = driftDelta == null
    ? !policy.non_regression.require_simulation
    : driftDelta <= policy.non_regression.max_drift_regression;
  const yieldOk = yieldDelta == null
    ? !policy.non_regression.require_simulation
    : yieldDelta <= policy.non_regression.max_yield_regression;

  return {
    pass: driftOk && yieldOk,
    reason: driftOk && yieldOk ? 'within_thresholds' : 'regression_detected',
    current_date: dateStr,
    baseline_date: baselineDate,
    current_drift: current.drift,
    baseline_drift: baseline.drift,
    drift_delta: driftDelta,
    max_drift_regression: policy.non_regression.max_drift_regression,
    current_yield_rate: current.yield_rate,
    baseline_yield_rate: baseline.yield_rate,
    yield_delta: yieldDelta,
    max_yield_regression: policy.non_regression.max_yield_regression
  };
}

function dailyReceiptPath(dateStr) {
  return path.join(REGIME_DIR, `${dateStr}.jsonl`);
}

function cmdRun(dateStr, policyPathRaw, maxActionsRaw) {
  const policyPath = path.resolve(String(
    policyPathRaw
      || process.env.FRACTAL_REGIME_POLICY_PATH
      || DEFAULT_POLICY_PATH
  ));
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    const outDisabled = {
      ok: true,
      type: 'fractal_regime_organ',
      date: dateStr,
      selected_regime: null,
      action_count: 0,
      disabled: true,
      reason: 'policy_disabled'
    };
    process.stdout.write(`${JSON.stringify(outDisabled)}\n`);
    return;
  }

  const maxActions = clampInt(
    maxActionsRaw == null ? policy.max_actions : maxActionsRaw,
    1,
    20,
    policy.max_actions
  );

  const objectiveId = objectiveFromRuns(dateStr);
  const context = {
    ts: nowIso(),
    date: dateStr,
    objective_id: objectiveId,
    queue: queueSnapshot(),
    runs: runMetrics(dateStr),
    sim: simulationForDate(dateStr),
    autopause: autopauseSnapshot(),
    trit: ternarySnapshot(dateStr)
  };

  const scores = computeRegimeScores(context);
  const candidate = pickCandidate(scores);
  const previousState = readJson(REGIME_STATE_PATH, {});
  const selection = resolveRegimeSelection(policy, previousState, candidate, scores);

  const actions = buildActions(
    dateStr,
    objectiveId,
    selection.selected_regime,
    policy,
    maxActions
  );

  const identityContext = loadIdentityContext({ date: dateStr });
  const identity = evaluateMorphActions(actions, {
    context: identityContext,
    source: 'fractal_regime_organ',
    objective_id: objectiveId || null
  });
  const blockedActionIds = new Set(Array.isArray(identity.blocked_actions) ? identity.blocked_actions : []);
  const filteredActions = actions.filter((row) => !blockedActionIds.has(String(row && row.id || '')));
  const identityReceipt = writeIdentityReceipt({
    context: identityContext,
    scope: 'morph',
    source: 'fractal_regime_organ',
    evaluations: identity.evaluations,
    summary: identity.summary
  });

  const nonRegression = evaluateNonRegression(dateStr, policy);
  const promotionReady = nonRegression.pass === true && Number(identity.summary && identity.summary.blocked || 0) === 0;

  const row = {
    schema_id: 'fractal_regime_receipt',
    schema_version: '1.0.0',
    ts: nowIso(),
    date: dateStr,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    objective_id: objectiveId,
    selected_regime: selection.selected_regime,
    candidate_regime: candidate.candidate_regime,
    switched: selection.switched === true,
    switch_reason: selection.reason,
    candidate_confidence: candidate.confidence,
    candidate_margin: candidate.margin,
    scores,
    actions: filteredActions,
    action_count: filteredActions.length,
    context,
    non_regression: nonRegression,
    identity: {
      checked: Number(identity.summary && identity.summary.checked || 0),
      blocked: Number(identity.summary && identity.summary.blocked || 0),
      identity_drift_score: Number(identity.summary && identity.summary.identity_drift_score || 0),
      max_identity_drift_score: Number(identity.summary && identity.summary.max_identity_drift_score || 0),
      blocking_code_counts: identity.summary && identity.summary.blocking_code_counts
        ? identity.summary.blocking_code_counts
        : {},
      blocked_action_ids: Array.isArray(identity.blocked_actions) ? identity.blocked_actions : [],
      receipt_path: identityReceipt && identityReceipt.receipt_path ? identityReceipt.receipt_path : null
    },
    promotion_ready: promotionReady,
    execution_mode: 'proposal_only'
  };

  const nextState = {
    active_regime: selection.selected_regime,
    active_since: selection.active_since,
    last_switch_ts: selection.last_switch_ts,
    cooldown_until: selection.cooldown_until,
    last_candidate_regime: candidate.candidate_regime,
    last_candidate_score: candidate.candidate_score,
    last_candidate_confidence: candidate.confidence,
    last_selected_score: safeNumber(scores && scores[selection.selected_regime], 0),
    last_reason: selection.reason,
    last_updated: nowIso()
  };

  const receiptPath = dailyReceiptPath(dateStr);
  appendJsonl(receiptPath, row);
  writeJsonAtomic(REGIME_LATEST_PATH, row);
  writeJsonAtomic(REGIME_STATE_PATH, nextState);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_regime_organ',
    date: dateStr,
    selected_regime: selection.selected_regime,
    candidate_regime: candidate.candidate_regime,
    switched: selection.switched === true,
    switch_reason: selection.reason,
    confidence: candidate.confidence,
    action_count: filteredActions.length,
    promotion_ready: promotionReady,
    non_regression_pass: nonRegression.pass === true,
    output_path: relPath(REGIME_LATEST_PATH),
    receipt_path: relPath(receiptPath)
  })}\n`);
}

function cmdStatus(dateStrOrLatest) {
  const token = String(dateStrOrLatest || 'latest').trim().toLowerCase();
  let payload = null;
  if (!token || token === 'latest') {
    payload = readJson(REGIME_LATEST_PATH, null);
  } else {
    const fp = dailyReceiptPath(dateArgOrToday(token));
    const rows = readJsonl(fp);
    payload = rows.length ? rows[rows.length - 1] : null;
  }

  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'fractal_regime_status',
      date: dateArgOrToday(dateStrOrLatest),
      error: 'regime_snapshot_not_found'
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_regime_status',
    date: payload.date || null,
    selected_regime: payload.selected_regime || null,
    candidate_regime: payload.candidate_regime || null,
    switched: payload.switched === true,
    switch_reason: payload.switch_reason || null,
    confidence: Number(payload.candidate_confidence || 0),
    action_count: Array.isArray(payload.actions) ? payload.actions.length : Number(payload.action_count || 0),
    promotion_ready: payload.promotion_ready === true,
    non_regression_pass: !!(payload.non_regression && payload.non_regression.pass === true),
    output_path: relPath(REGIME_LATEST_PATH)
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'run') {
    cmdRun(
      dateArgOrToday(args._[1]),
      args.policy,
      args['max-actions']
    );
    return;
  }

  if (cmd === 'status') {
    cmdStatus(args._[1] || 'latest');
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  computeRegimeScores,
  resolveRegimeSelection,
  buildActions,
  evaluateNonRegression
};

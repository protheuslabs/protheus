#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/autonomy/mirror_organ.js
 *
 * V2-047 Mirror Organ.
 * Upgrades read-only observer signals into proposal-only self-critique outputs.
 *
 * Guarantees:
 * - no direct mutation path
 * - auditable/replayable evidence references
 * - bounded proposal count and confidence gating
 *
 * Usage:
 *   node systems/autonomy/mirror_organ.js run [YYYY-MM-DD] [--policy=path] [--days=3] [--max-proposals=6] [--dry-run=1|0]
 *   node systems/autonomy/mirror_organ.js status [latest|YYYY-MM-DD]
 *   node systems/autonomy/mirror_organ.js replay --proposal-id=<id> [--date=YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

type EvidenceRef = {
  type: string,
  path: string,
  note: string
};

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'mirror_organ_policy.json');

const RUNS_DIR = process.env.MIRROR_ORGAN_RUNS_DIR
  ? path.resolve(process.env.MIRROR_ORGAN_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const SIM_DIR = process.env.MIRROR_ORGAN_SIM_DIR
  ? path.resolve(process.env.MIRROR_ORGAN_SIM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const INTROSPECTION_DIR = process.env.MIRROR_ORGAN_INTROSPECTION_DIR
  ? path.resolve(process.env.MIRROR_ORGAN_INTROSPECTION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'introspection');
const REGIME_LATEST_PATH = process.env.MIRROR_ORGAN_REGIME_LATEST_PATH
  ? path.resolve(process.env.MIRROR_ORGAN_REGIME_LATEST_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'regime', 'latest.json');
const ORGANISM_CYCLE_DIR = process.env.MIRROR_ORGAN_ORGANISM_CYCLE_DIR
  ? path.resolve(process.env.MIRROR_ORGAN_ORGANISM_CYCLE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'organism_cycle');

const OUT_DIR = process.env.MIRROR_ORGAN_OUT_DIR
  ? path.resolve(process.env.MIRROR_ORGAN_OUT_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'mirror_organ');
const RUN_OUT_DIR = path.join(OUT_DIR, 'runs');
const SUGGESTIONS_DIR = path.join(OUT_DIR, 'suggestions');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

const ALLOWED_KINDS = new Set(['epigenetic_tag', 'split', 'prune', 'rewire']);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/mirror_organ.js run [YYYY-MM-DD] [--policy=path] [--days=3] [--max-proposals=6] [--dry-run=1|0]');
  console.log('  node systems/autonomy/mirror_organ.js status [latest|YYYY-MM-DD]');
  console.log('  node systems/autonomy/mirror_organ.js replay --proposal-id=<id> [--date=YYYY-MM-DD]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function shiftDate(dateStr: string, deltaDays: number) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr: string, days: number) {
  const n = Math.max(1, Math.floor(Number(days || 1)));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
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

function clamp01(v: unknown, fallback = 0) {
  return clampNumber(v, 0, 1, fallback);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function safeNumber(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(v: unknown, maxLen = 200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload == null ? fallback : payload;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
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

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function stableId(seed: string, prefix = 'mir') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function isPolicyHoldResult(result: unknown) {
  const normalized = String(result || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'policy_hold'
    || normalized.startsWith('no_candidates_policy_')
    || normalized.startsWith('stop_init_gate_')
    || normalized.startsWith('stop_repeat_gate_');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_mode: true,
    proposal_only: true,
    window_days: 3,
    max_proposals: 6,
    min_confidence: 0.56,
    thresholds: {
      drift_warn: 0.03,
      drift_critical: 0.06,
      yield_warn: 0.68,
      yield_critical: 0.55,
      hold_warn: 0.35,
      hold_critical: 0.6,
      no_change_warn: 0.45,
      no_change_critical: 0.75
    },
    weights: {
      drift: 0.28,
      yield: 0.24,
      hold: 0.2,
      no_change: 0.16,
      queue: 0.12
    },
    queue: {
      normal: 0,
      elevated: 0.35,
      high: 0.72,
      critical: 1
    },
    kinds: {
      epigenetic_tag: true,
      split: true,
      prune: true,
      rewire: true
    },
    telemetry: {
      max_evidence_refs: 8,
      max_reasons: 8
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw && raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const weights = raw && raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const queue = raw && raw.queue && typeof raw.queue === 'object' ? raw.queue : {};
  const kinds = raw && raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {};
  const telemetry = raw && raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};

  const normKinds: AnyObj = {};
  for (const kind of ALLOWED_KINDS) {
    normKinds[kind] = kinds[kind] !== false;
  }

  const normQueue: AnyObj = {};
  for (const [k, v] of Object.entries(base.queue)) {
    normQueue[k] = clamp01(queue[k], Number(v));
  }

  return {
    version: cleanText(raw.version || base.version, 24) || '1.0',
    enabled: raw.enabled !== false,
    shadow_mode: raw.shadow_mode !== false,
    proposal_only: raw.proposal_only !== false,
    window_days: clampInt(raw.window_days, 1, 30, base.window_days),
    max_proposals: clampInt(raw.max_proposals, 1, 24, base.max_proposals),
    min_confidence: clamp01(raw.min_confidence, base.min_confidence),
    thresholds: {
      drift_warn: clampNumber(thresholds.drift_warn, 0, 1, base.thresholds.drift_warn),
      drift_critical: clampNumber(thresholds.drift_critical, 0, 1, base.thresholds.drift_critical),
      yield_warn: clampNumber(thresholds.yield_warn, 0, 1, base.thresholds.yield_warn),
      yield_critical: clampNumber(thresholds.yield_critical, 0, 1, base.thresholds.yield_critical),
      hold_warn: clampNumber(thresholds.hold_warn, 0, 1, base.thresholds.hold_warn),
      hold_critical: clampNumber(thresholds.hold_critical, 0, 1, base.thresholds.hold_critical),
      no_change_warn: clampNumber(thresholds.no_change_warn, 0, 1, base.thresholds.no_change_warn),
      no_change_critical: clampNumber(thresholds.no_change_critical, 0, 1, base.thresholds.no_change_critical)
    },
    weights: {
      drift: clampNumber(weights.drift, 0.01, 2, base.weights.drift),
      yield: clampNumber(weights.yield, 0.01, 2, base.weights.yield),
      hold: clampNumber(weights.hold, 0.01, 2, base.weights.hold),
      no_change: clampNumber(weights.no_change, 0.01, 2, base.weights.no_change),
      queue: clampNumber(weights.queue, 0.01, 2, base.weights.queue)
    },
    queue: normQueue,
    kinds: normKinds,
    telemetry: {
      max_evidence_refs: clampInt(telemetry.max_evidence_refs, 1, 32, base.telemetry.max_evidence_refs),
      max_reasons: clampInt(telemetry.max_reasons, 1, 32, base.telemetry.max_reasons)
    }
  };
}

function runFilePath(dateStr: string) {
  ensureDir(RUN_OUT_DIR);
  return path.join(RUN_OUT_DIR, `${toDate(dateStr)}.jsonl`);
}

function suggestionsFilePath(dateStr: string) {
  ensureDir(SUGGESTIONS_DIR);
  return path.join(SUGGESTIONS_DIR, `${toDate(dateStr)}.json`);
}

function availableRef(filePath: string) {
  return fs.existsSync(filePath) ? relPath(filePath) : null;
}

function runWindowSummary(dateStr: string, days: number) {
  const counts = {
    runs: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    policy_holds: 0
  };
  const byObjective: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byTypeNoChange: Record<string, number> = {};
  const evidenceRefs: EvidenceRef[] = [];
  let daysWithRuns = 0;

  for (const day of windowDates(dateStr, days)) {
    const fp = path.join(RUNS_DIR, `${day}.jsonl`);
    const rows = readJsonl(fp);
    let dayRuns = 0;
    for (const row of rows) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      dayRuns += 1;
      counts.runs += 1;
      const result = String(row && row.result || '').trim().toLowerCase();
      const outcome = String(row && row.outcome || '').trim().toLowerCase();
      const objective = normalizeToken(row && row.objective_id || 'none', 120) || 'none';
      const proposalType = normalizeToken(row && row.proposal_type || 'unknown', 80) || 'unknown';

      byObjective[objective] = Number(byObjective[objective] || 0) + 1;
      byType[proposalType] = Number(byType[proposalType] || 0) + 1;

      if (result === 'executed') counts.executed += 1;
      if (outcome === 'shipped') counts.shipped += 1;
      if (outcome === 'no_change') {
        counts.no_change += 1;
        byTypeNoChange[proposalType] = Number(byTypeNoChange[proposalType] || 0) + 1;
      }
      if (isPolicyHoldResult(result)) counts.policy_holds += 1;
    }
    if (dayRuns > 0) {
      daysWithRuns += 1;
      evidenceRefs.push({
        type: 'autonomy_runs',
        path: relPath(fp),
        note: `autonomy_run rows=${dayRuns}`
      });
    }
  }

  const holdRate = counts.runs > 0 ? counts.policy_holds / counts.runs : 0;
  const noChangeRate = counts.executed > 0 ? counts.no_change / counts.executed : 0;
  const shipRate = counts.executed > 0 ? counts.shipped / counts.executed : 0;

  const topObjective = Object.entries(byObjective).sort((a, b) => b[1] - a[1])[0] || null;
  const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0] || null;
  const topNoChangeType = Object.entries(byTypeNoChange).sort((a, b) => b[1] - a[1])[0] || null;

  return {
    counts,
    rates: {
      hold_rate: Number(holdRate.toFixed(6)),
      no_change_rate: Number(noChangeRate.toFixed(6)),
      ship_rate: Number(shipRate.toFixed(6))
    },
    days_with_runs: daysWithRuns,
    top_objective_id: topObjective ? topObjective[0] : null,
    top_proposal_type: topType ? topType[0] : null,
    top_no_change_type: topNoChangeType ? topNoChangeType[0] : null,
    evidence_refs: evidenceRefs,
    by_type: byType,
    by_type_no_change: byTypeNoChange
  };
}

function simulationSummary(dateStr: string, days: number) {
  const dates = windowDates(dateStr, days).reverse();
  for (const day of dates) {
    const fp = path.join(SIM_DIR, `${day}.json`);
    if (!fs.existsSync(fp)) continue;
    const payload = readJson(fp, {});
    const checks = payload && payload.checks_effective && typeof payload.checks_effective === 'object'
      ? payload.checks_effective
      : (payload && payload.checks && typeof payload.checks === 'object' ? payload.checks : {});
    const drift = safeNumber(checks && checks.drift_rate && checks.drift_rate.value, NaN);
    const yieldRate = safeNumber(checks && checks.yield_rate && checks.yield_rate.value, NaN);
    return {
      date: day,
      drift_rate: Number.isFinite(drift) ? Number(drift.toFixed(6)) : null,
      yield_rate: Number.isFinite(yieldRate) ? Number(yieldRate.toFixed(6)) : null,
      evidence_ref: {
        type: 'simulation',
        path: relPath(fp),
        note: `effective drift=${Number.isFinite(drift) ? Number(drift.toFixed(4)) : 'n/a'} yield=${Number.isFinite(yieldRate) ? Number(yieldRate.toFixed(4)) : 'n/a'}`
      }
    };
  }
  return {
    date: null,
    drift_rate: null,
    yield_rate: null,
    evidence_ref: null
  };
}

function introspectionSummary(dateStr: string, days: number, queueMap: AnyObj) {
  const queueCounts: Record<string, number> = {};
  let latest: AnyObj = null;
  const evidenceRefs: EvidenceRef[] = [];
  let daysWithData = 0;

  for (const day of windowDates(dateStr, days)) {
    const fp = path.join(INTROSPECTION_DIR, `${day}.json`);
    if (!fs.existsSync(fp)) continue;
    const payload = readJson(fp, {});
    const snap = payload && payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
    const queuePressure = normalizeToken(snap && snap.queue && snap.queue.pressure || 'unknown', 24) || 'unknown';
    const restructureCandidates = Array.isArray(payload && payload.restructure_candidates)
      ? payload.restructure_candidates.length
      : 0;
    const row = {
      date: day,
      queue_pressure: queuePressure,
      queue_score: clamp01(queueMap[queuePressure], clamp01(queueMap.normal, 0)),
      restructure_candidates: restructureCandidates,
      autopause_active: !!(snap && snap.autopause && snap.autopause.active === true)
    };
    latest = row;
    daysWithData += 1;
    queueCounts[queuePressure] = Number(queueCounts[queuePressure] || 0) + 1;
    evidenceRefs.push({
      type: 'introspection',
      path: relPath(fp),
      note: `queue=${queuePressure} restructure_candidates=${restructureCandidates}`
    });
  }

  if (!latest) {
    latest = {
      date: null,
      queue_pressure: 'unknown',
      queue_score: clamp01(queueMap.unknown, clamp01(queueMap.normal, 0)),
      restructure_candidates: 0,
      autopause_active: false
    };
  }

  return {
    ...latest,
    days_with_data: daysWithData,
    queue_counts: queueCounts,
    evidence_refs: evidenceRefs
  };
}

function regimeSummary() {
  const payload = readJson(REGIME_LATEST_PATH, null);
  if (!payload || typeof payload !== 'object') return null;
  return {
    selected_regime: cleanText(payload.selected_regime || 'unknown', 64),
    confidence: clamp01(payload.candidate_confidence, 0),
    switched: payload.switched === true,
    evidence_ref: {
      type: 'regime',
      path: relPath(REGIME_LATEST_PATH),
      note: `selected=${cleanText(payload.selected_regime || 'unknown', 48)} confidence=${Number(clamp01(payload.candidate_confidence, 0)).toFixed(3)}`
    }
  };
}

function organismCycleSummary(dateStr: string, days: number) {
  const dates = windowDates(dateStr, days).reverse();
  for (const day of dates) {
    const fp = path.join(ORGANISM_CYCLE_DIR, `${day}.json`);
    if (!fs.existsSync(fp)) continue;
    const payload = readJson(fp, {});
    return {
      date: day,
      harmony_score: Number(clamp01(payload && payload.harmony_score, 0).toFixed(6)),
      pheromones: Math.max(0, Number(payload && payload.pheromones || 0)),
      archetypes: Math.max(0, Number(payload && payload.archetypes || 0)),
      evidence_ref: {
        type: 'organism_cycle',
        path: relPath(fp),
        note: `harmony=${Number(clamp01(payload && payload.harmony_score, 0)).toFixed(3)} archetypes=${Math.max(0, Number(payload && payload.archetypes || 0))}`
      }
    };
  }
  return null;
}

function pressureUpperWorse(value: unknown, warn: number, critical: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { available: false, score: 0 };
  const w = Math.min(warn, critical);
  const c = Math.max(warn, critical);
  if (n <= w) return { available: true, score: 0 };
  if (n >= c) return { available: true, score: 1 };
  return { available: true, score: Number(((n - w) / Math.max(0.000001, c - w)).toFixed(6)) };
}

function pressureLowerWorse(value: unknown, warn: number, critical: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { available: false, score: 0 };
  const w = Math.max(warn, critical);
  const c = Math.min(warn, critical);
  if (n >= w) return { available: true, score: 0 };
  if (n <= c) return { available: true, score: 1 };
  return { available: true, score: Number(((w - n) / Math.max(0.000001, w - c)).toFixed(6)) };
}

function boundedEvidenceRefs(refs: EvidenceRef[], limit: number) {
  const out: EvidenceRef[] = [];
  const seen = new Set();
  for (const row of refs) {
    if (!row || typeof row !== 'object') continue;
    const key = `${String(row.type || '')}|${String(row.path || '')}`;
    if (!String(row.path || '').trim() || seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: cleanText(row.type || 'evidence', 32),
      path: cleanText(row.path || '', 260),
      note: cleanText(row.note || '', 220)
    });
    if (out.length >= limit) break;
  }
  return out;
}

function computeSignals(dateStr: string, policy: AnyObj, days: number) {
  const windowDays = Math.max(1, days);
  const run = runWindowSummary(dateStr, windowDays);
  const sim = simulationSummary(dateStr, windowDays);
  const introspection = introspectionSummary(dateStr, windowDays, policy.queue || {});
  const regime = regimeSummary();
  const cycle = organismCycleSummary(dateStr, windowDays);

  const drift = pressureUpperWorse(
    sim.drift_rate,
    Number(policy.thresholds && policy.thresholds.drift_warn || 0.03),
    Number(policy.thresholds && policy.thresholds.drift_critical || 0.06)
  );
  const yieldPressure = pressureLowerWorse(
    sim.yield_rate,
    Number(policy.thresholds && policy.thresholds.yield_warn || 0.68),
    Number(policy.thresholds && policy.thresholds.yield_critical || 0.55)
  );
  const holds = pressureUpperWorse(
    run.rates.hold_rate,
    Number(policy.thresholds && policy.thresholds.hold_warn || 0.35),
    Number(policy.thresholds && policy.thresholds.hold_critical || 0.6)
  );
  const noChange = pressureUpperWorse(
    run.rates.no_change_rate,
    Number(policy.thresholds && policy.thresholds.no_change_warn || 0.45),
    Number(policy.thresholds && policy.thresholds.no_change_critical || 0.75)
  );

  const queueScore = clamp01(introspection.queue_score, 0);
  const queue = { available: true, score: queueScore };

  const weightedEntries = [
    { key: 'drift', weight: Number(policy.weights && policy.weights.drift || 0.28), item: drift },
    { key: 'yield', weight: Number(policy.weights && policy.weights.yield || 0.24), item: yieldPressure },
    { key: 'hold', weight: Number(policy.weights && policy.weights.hold || 0.2), item: holds },
    { key: 'no_change', weight: Number(policy.weights && policy.weights.no_change || 0.16), item: noChange },
    { key: 'queue', weight: Number(policy.weights && policy.weights.queue || 0.12), item: queue }
  ].filter((row) => Number(row.weight) > 0 && row.item.available === true);

  const weightSum = weightedEntries.reduce((sum, row) => sum + Number(row.weight || 0), 0);
  const weightedScore = weightedEntries.reduce((sum, row) => sum + (Number(row.item.score || 0) * Number(row.weight || 0)), 0);
  const pressureScore = weightSum > 0 ? clamp01(weightedScore / weightSum, 0) : 0;

  const availableMetricCount = [drift, yieldPressure, holds, noChange, queue].filter((row) => row.available === true).length;
  const dataCoverage = clamp01(
    (availableMetricCount / 5) * 0.45
      + clamp01(run.counts.runs / 36, 0) * 0.3
      + clamp01((run.days_with_runs + introspection.days_with_data) / (windowDays * 2), 0) * 0.25,
    0
  );

  const confidence = clamp01(0.25 + (dataCoverage * 0.75), 0);

  const allRefs: EvidenceRef[] = [
    ...(Array.isArray(run.evidence_refs) ? run.evidence_refs : []),
    ...(Array.isArray(introspection.evidence_refs) ? introspection.evidence_refs : []),
    ...(sim.evidence_ref ? [sim.evidence_ref] : []),
    ...(regime && regime.evidence_ref ? [regime.evidence_ref] : []),
    ...(cycle && cycle.evidence_ref ? [cycle.evidence_ref] : [])
  ];

  return {
    run,
    sim,
    introspection,
    regime,
    cycle,
    components: {
      drift: Number(drift.score.toFixed(6)),
      yield: Number(yieldPressure.score.toFixed(6)),
      hold: Number(holds.score.toFixed(6)),
      no_change: Number(noChange.score.toFixed(6)),
      queue: Number(queue.score.toFixed(6))
    },
    pressure_score: Number(pressureScore.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    evidence_refs: boundedEvidenceRefs(allRefs, Number(policy.telemetry && policy.telemetry.max_evidence_refs || 8))
  };
}

function proposalConfidence(baseConfidence: number, componentScore: number) {
  const out = clamp01((baseConfidence * 0.6) + (clamp01(componentScore, 0) * 0.4), 0);
  return Number(out.toFixed(6));
}

function createProposal(seed: string, args: AnyObj) {
  return {
    id: stableId(seed, 'mir'),
    source: 'mirror_organ',
    type: 'mirror_self_critique',
    status: 'proposed',
    date: args.date,
    kind: args.kind,
    title: cleanText(args.title, 96),
    summary: cleanText(args.summary, 260),
    confidence: Number(clamp01(args.confidence, 0).toFixed(6)),
    pressure_component: cleanText(args.pressure_component, 32),
    pressure_score: Number(clamp01(args.pressure_score, 0).toFixed(6)),
    global_pressure_score: Number(clamp01(args.global_pressure_score, 0).toFixed(6)),
    objective_id: cleanText(args.objective_id || '', 120) || null,
    action: args.action && typeof args.action === 'object' ? args.action : {},
    evidence_refs: Array.isArray(args.evidence_refs) ? args.evidence_refs : [],
    replay_token: stableId(`${seed}|replay`, 'rep'),
    shadow_mode: args.shadow_mode === true,
    execution_mode: args.execution_mode || 'proposal_only'
  };
}

function buildProposals(dateStr: string, policy: AnyObj, signals: AnyObj, maxProposals: number) {
  const out: AnyObj[] = [];
  const components = signals && signals.components && typeof signals.components === 'object'
    ? signals.components
    : {};
  const baseConfidence = Number(signals && signals.confidence || 0);
  const globalPressure = Number(signals && signals.pressure_score || 0);
  const objectiveId = cleanText(signals && signals.run && signals.run.top_objective_id || 'mirror_stability', 120) || 'mirror_stability';
  const topType = cleanText(signals && signals.run && signals.run.top_proposal_type || 'unknown', 80) || 'unknown';
  const topNoChangeType = cleanText(signals && signals.run && signals.run.top_no_change_type || topType, 80) || 'unknown';
  const queuePressure = cleanText(signals && signals.introspection && signals.introspection.queue_pressure || 'unknown', 24) || 'unknown';
  const restructureCount = Math.max(0, Number(signals && signals.introspection && signals.introspection.restructure_candidates || 0));
  const driftRate = signals && signals.sim ? signals.sim.drift_rate : null;
  const yieldRate = signals && signals.sim ? signals.sim.yield_rate : null;

  const pushIfAllowed = (kind: string, proposal: AnyObj, componentKey: string) => {
    if (policy.kinds && policy.kinds[kind] === false) return;
    const compScore = Number(components[componentKey] || 0);
    if (compScore <= 0.05) return;
    const confidence = proposalConfidence(baseConfidence, compScore);
    if (confidence < Number(policy.min_confidence || 0.56)) return;
    out.push(createProposal(
      `${dateStr}|${kind}|${proposal.title}|${componentKey}`,
      {
        ...proposal,
        kind,
        date: dateStr,
        confidence,
        pressure_component: componentKey,
        pressure_score: compScore,
        global_pressure_score: globalPressure,
        objective_id: objectiveId,
        evidence_refs: signals.evidence_refs,
        shadow_mode: policy.shadow_mode === true,
        execution_mode: policy.proposal_only === false ? 'proposal_only' : 'proposal_only'
      }
    ));
  };

  pushIfAllowed('epigenetic_tag', {
    title: 'Constrain exploration under drift pressure',
    summary: `Effective drift pressure is elevated (${driftRate == null ? 'n/a' : Number(driftRate).toFixed(4)}). Propose temporary stabilizer tag to reduce high-risk exploration mutations.`,
    action: {
      tag: 'mirror_drift_stabilize',
      ttl_hours: 72,
      target_lanes: ['workflow_mutation', 'exploration']
    }
  }, 'drift');

  pushIfAllowed('split', {
    title: 'Split intake and validation under hold pressure',
    summary: `Policy-hold pressure is elevated. Propose split between intake and validation lanes to isolate blockers and reduce repeated hold churn.`,
    action: {
      split_target: 'intake_validation_lane',
      mode: 'shadow_plan',
      expected_effect: 'lower_policy_hold_rate'
    }
  }, 'hold');

  pushIfAllowed('prune', {
    title: 'Prune low-yield attempt class',
    summary: `No-change pressure is elevated; top low-yield proposal class is ${topNoChangeType}. Propose bounded prune/quarantine for this class until evidence improves.`,
    action: {
      prune_target: `proposal_type:${topNoChangeType}`,
      mode: 'quarantine',
      review_after_days: 7
    }
  }, 'no_change');

  pushIfAllowed('rewire', {
    title: 'Rewire queue dispatch by confidence pressure',
    summary: `Queue pressure (${queuePressure})${restructureCount > 0 ? ` with ${restructureCount} restructure candidates` : ''}. Propose confidence-first dispatch and defer low-signal work.`,
    action: {
      rewire_target: 'queue_dispatch',
      strategy: 'confidence_first_then_fifo',
      primary_type_hint: topType
    }
  }, 'queue');

  // Low yield can trigger either prune or rewire depending on what already exists.
  const yieldScore = Number(components.yield || 0);
  if (yieldScore > 0.25 && out.length < Math.max(1, maxProposals)) {
    pushIfAllowed('rewire', {
      title: 'Rewire execution path for low-yield pressure',
      summary: `Yield pressure is elevated (${yieldRate == null ? 'n/a' : Number(yieldRate).toFixed(4)}). Propose pre-execution verification gate before expensive paths.`,
      action: {
        rewire_target: 'execution_gate',
        strategy: 'verify_before_execute',
        confidence_floor: 0.62
      }
    }, 'yield');
  }

  const uniq = [];
  const seen = new Set();
  for (const row of out) {
    const key = `${row.kind}|${row.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(row);
  }

  uniq.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  return uniq.slice(0, Math.max(1, maxProposals));
}

function toSuggestionRows(proposals: AnyObj[]) {
  const out = [];
  for (const row of Array.isArray(proposals) ? proposals : []) {
    const confidence = clamp01(row && row.confidence, 0);
    const pressure = clamp01(row && row.pressure_score, 0);
    const priority = clamp01((confidence * 0.65) + (pressure * 0.35), 0.45);
    out.push({
      id: String(row && row.id || ''),
      type: 'mirror_self_critique_suggestion',
      kind: cleanText(row && row.kind || '', 32),
      status: 'proposed',
      date: cleanText(row && row.date || '', 16),
      source: 'mirror_organ',
      source_ref: String(row && row.id || ''),
      title: cleanText(row && row.title || 'Mirror self-critique suggestion', 110),
      summary: cleanText(row && row.summary || '', 240),
      confidence: Number(confidence.toFixed(6)),
      pressure_score: Number(pressure.toFixed(6)),
      priority: Number(priority.toFixed(6)),
      objective_id: cleanText(row && row.objective_id || '', 120) || null,
      execution_mode: 'proposal_only',
      evidence_refs: Array.isArray(row && row.evidence_refs) ? row.evidence_refs : [],
      action: row && row.action && typeof row.action === 'object' ? row.action : {}
    });
  }
  return out;
}

function persistRun(dateStr: string, payload: AnyObj) {
  const runPath = runFilePath(dateStr);
  appendJsonl(runPath, payload);
  appendJsonl(HISTORY_PATH, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  const suggestions = toSuggestionRows(Array.isArray(payload.proposals) ? payload.proposals : []);
  writeJsonAtomic(suggestionsFilePath(dateStr), suggestions);
  return {
    run_path: relPath(runPath),
    latest_path: relPath(LATEST_PATH),
    history_path: relPath(HISTORY_PATH),
    suggestions_path: relPath(suggestionsFilePath(dateStr))
  };
}

function replayRows(dateStr: string | null) {
  const rows: AnyObj[] = [];
  if (dateStr) {
    rows.push(...readJsonl(runFilePath(dateStr)));
    return rows;
  }
  const latest = readJson(LATEST_PATH, null);
  if (latest && typeof latest === 'object') rows.push(latest);
  const history = readJsonl(HISTORY_PATH);
  for (let i = history.length - 1; i >= 0; i -= 1) rows.push(history[i]);
  return rows;
}

function cmdRun(dateStr: string, args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.MIRROR_ORGAN_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const windowDays = clampInt(args.days, 1, 30, Number(policy.window_days || 3));
  const maxProposals = clampInt(args['max-proposals'], 1, 24, Number(policy.max_proposals || 6));
  const dryRun = toBool(args['dry-run'], false);

  if (policy.enabled !== true) {
    const payload = {
      ok: true,
      type: 'mirror_organ',
      ts: nowIso(),
      date: dateStr,
      skipped: true,
      reason: 'policy_disabled',
      policy_path: relPath(policyPath),
      policy_version: policy.version,
      execution_mode: 'proposal_only',
      proposal_count: 0,
      pressure_score: 0,
      confidence: 0,
      proposals: []
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const signals = computeSignals(dateStr, policy, windowDays);
  const proposals = buildProposals(dateStr, policy, signals, maxProposals);

  const reasons = [];
  if (signals.components.drift > 0.45) reasons.push('drift_pressure_elevated');
  if (signals.components.hold > 0.45) reasons.push('policy_hold_pressure_elevated');
  if (signals.components.no_change > 0.45) reasons.push('no_change_pressure_elevated');
  if (signals.components.queue > 0.55) reasons.push('queue_pressure_elevated');
  if (signals.components.yield > 0.4) reasons.push('yield_pressure_elevated');

  const payload = {
    ok: true,
    type: 'mirror_organ',
    ts: nowIso(),
    date: dateStr,
    policy_path: relPath(policyPath),
    policy_version: policy.version,
    skipped: false,
    dry_run: dryRun,
    window_days: windowDays,
    max_proposals: maxProposals,
    min_confidence: Number(policy.min_confidence || 0),
    shadow_mode: policy.shadow_mode === true,
    proposal_only: true,
    execution_mode: 'proposal_only',
    pressure_score: Number(clamp01(signals.pressure_score, 0).toFixed(6)),
    confidence: Number(clamp01(signals.confidence, 0).toFixed(6)),
    components: signals.components,
    summary: {
      runs: Number(signals.run && signals.run.counts && signals.run.counts.runs || 0),
      executed: Number(signals.run && signals.run.counts && signals.run.counts.executed || 0),
      ship_rate: Number(signals.run && signals.run.rates && signals.run.rates.ship_rate || 0),
      hold_rate: Number(signals.run && signals.run.rates && signals.run.rates.hold_rate || 0),
      no_change_rate: Number(signals.run && signals.run.rates && signals.run.rates.no_change_rate || 0),
      drift_rate: signals.sim && signals.sim.drift_rate != null ? Number(signals.sim.drift_rate) : null,
      yield_rate: signals.sim && signals.sim.yield_rate != null ? Number(signals.sim.yield_rate) : null,
      queue_pressure: cleanText(signals.introspection && signals.introspection.queue_pressure || 'unknown', 24),
      regime: signals.regime ? cleanText(signals.regime.selected_regime || 'unknown', 48) : null,
      harmony_score: signals.cycle ? Number(signals.cycle.harmony_score || 0) : null
    },
    top_objective_id: signals.run && signals.run.top_objective_id ? signals.run.top_objective_id : null,
    proposal_count: proposals.length,
    proposals,
    evidence_refs: Array.isArray(signals.evidence_refs)
      ? signals.evidence_refs.slice(0, Number(policy.telemetry && policy.telemetry.max_evidence_refs || 8))
      : [],
    reasons: reasons.slice(0, Number(policy.telemetry && policy.telemetry.max_reasons || 8))
  };

  let persisted: AnyObj = {
    run_path: null,
    latest_path: relPath(LATEST_PATH),
    history_path: relPath(HISTORY_PATH),
    suggestions_path: relPath(suggestionsFilePath(dateStr))
  };
  if (!dryRun) {
    persisted = persistRun(dateStr, payload);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'mirror_organ',
    date: dateStr,
    window_days: windowDays,
    pressure_score: payload.pressure_score,
    confidence: payload.confidence,
    proposal_count: payload.proposal_count,
    shadow_mode: payload.shadow_mode,
    execution_mode: 'proposal_only',
    persisted: dryRun !== true,
    run_path: dryRun ? null : persisted.run_path,
    latest_path: persisted.latest_path,
    suggestions_path: dryRun ? null : persisted.suggestions_path
  })}\n`);
}

function cmdStatus(dateToken: string) {
  const token = String(dateToken || 'latest').trim().toLowerCase();
  let payload = null;
  if (!token || token === 'latest') {
    payload = readJson(LATEST_PATH, null);
  } else {
    const rows = readJsonl(runFilePath(toDate(token)));
    payload = rows.length ? rows[rows.length - 1] : null;
  }

  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'mirror_organ_status',
      date: token === 'latest' ? toDate(null) : toDate(token),
      error: 'mirror_snapshot_not_found'
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'mirror_organ_status',
    date: cleanText(payload.date || '', 16) || null,
    pressure_score: Number(payload.pressure_score || 0),
    confidence: Number(payload.confidence || 0),
    proposal_count: Array.isArray(payload.proposals) ? payload.proposals.length : Number(payload.proposal_count || 0),
    queue_pressure: payload.summary && payload.summary.queue_pressure ? payload.summary.queue_pressure : null,
    top_objective_id: payload.top_objective_id || null,
    execution_mode: 'proposal_only',
    output_path: relPath(LATEST_PATH)
  })}\n`);
}

function cmdReplay(args: AnyObj) {
  const proposalId = cleanText(args['proposal-id'] || args.proposal_id || '', 120);
  const dateStr = args.date ? toDate(args.date) : null;
  if (!proposalId) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'mirror_organ_replay',
      error: 'proposal_id_required'
    })}\n`);
    process.exitCode = 2;
    return;
  }

  const rows = replayRows(dateStr);
  for (const row of rows) {
    const proposals = Array.isArray(row && row.proposals) ? row.proposals : [];
    const proposal = proposals.find((p) => String(p && p.id || '') === proposalId);
    if (!proposal) continue;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'mirror_organ_replay',
      proposal_id: proposalId,
      date: row.date || null,
      pressure_score: Number(row.pressure_score || 0),
      confidence: Number(row.confidence || 0),
      proposal,
      evidence_refs: Array.isArray(proposal && proposal.evidence_refs)
        ? proposal.evidence_refs
        : (Array.isArray(row.evidence_refs) ? row.evidence_refs : []),
      run_path: row.date ? relPath(runFilePath(row.date)) : null,
      latest_path: relPath(LATEST_PATH)
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: false,
    type: 'mirror_organ_replay',
    proposal_id: proposalId,
    date: dateStr,
    error: 'proposal_not_found'
  })}\n`);
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 32).toLowerCase();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }

  if (cmd === 'run') {
    cmdRun(toDate(args._[1]), args);
    return;
  }

  if (cmd === 'status') {
    cmdStatus(cleanText(args._[1] || 'latest', 32));
    return;
  }

  if (cmd === 'replay') {
    cmdReplay(args);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  computeSignals,
  buildProposals,
  toSuggestionRows,
  loadPolicy
};

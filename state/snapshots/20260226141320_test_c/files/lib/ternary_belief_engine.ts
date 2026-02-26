import {
  TRIT_PAIN,
  TRIT_UNKNOWN,
  TRIT_OK,
  normalizeTrit,
  tritLabel,
  majorityTrit,
  consensusTrit,
  propagateTrit,
  serializeTritVector
} from './trit';

type AnyObj = Record<string, any>;

type SignalInput = {
  source?: unknown;
  trit?: unknown;
  weight?: unknown;
  confidence?: unknown;
  tags?: unknown;
  meta?: unknown;
  ts?: unknown;
};

type BeliefOptions = {
  label?: unknown;
  default_weight?: unknown;
  positive_threshold?: unknown;
  negative_threshold?: unknown;
  evidence_saturation_count?: unknown;
  source_trust?: unknown;
  source_trust_floor?: unknown;
  source_trust_ceiling?: unknown;
  freshness_half_life_hours?: unknown;
  now_iso?: unknown;
  min_non_neutral_signals?: unknown;
  min_non_neutral_weight?: unknown;
  min_confidence_for_non_neutral?: unknown;
  force_neutral_on_insufficient_evidence?: unknown;
};

type MergeOptions = {
  mode?: unknown;
  parent_weight?: unknown;
  child_weight?: unknown;
};

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function roundTo(value: unknown, digits = 4): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

function normalizeSource(value: unknown, idx: number): string {
  const text = String(value == null ? '' : value).trim();
  return text || `signal_${idx + 1}`;
}

function parseTsMs(value: unknown) {
  const ms = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ms) ? ms : null;
}

function sourceTrustValue(sourceTrust: unknown, source: string, fallback = 1) {
  const map = sourceTrust && typeof sourceTrust === 'object'
    ? sourceTrust as Record<string, any>
    : {};
  const direct = map[source];
  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  const lower = map[String(source || '').toLowerCase()];
  if (lower != null && Number.isFinite(Number(lower))) return Number(lower);
  const rec = direct && typeof direct === 'object' ? direct : lower && typeof lower === 'object' ? lower : null;
  if (rec) {
    if (Number.isFinite(Number(rec.trust))) return Number(rec.trust);
    if (Number.isFinite(Number(rec.weight))) return Number(rec.weight);
  }
  return fallback;
}

function signalFreshnessFactor(signalTsMs: number | null, nowMs: number | null, halfLifeHours: number) {
  if (signalTsMs == null || nowMs == null) return 1;
  if (!Number.isFinite(signalTsMs) || !Number.isFinite(nowMs)) return 1;
  const ageMs = Math.max(0, Number(nowMs) - Number(signalTsMs));
  const halfLifeMs = Math.max(1, Number(halfLifeHours)) * 60 * 60 * 1000;
  const decayPower = ageMs / halfLifeMs;
  return Math.max(0.05, Math.min(1, Math.pow(0.5, decayPower)));
}

function normalizeSignal(
  row: SignalInput,
  idx: number,
  defaultWeight: number,
  opts: {
    source_trust?: unknown;
    source_trust_floor?: number;
    source_trust_ceiling?: number;
    now_ms?: number | null;
    freshness_half_life_hours?: number;
    min_confidence_for_non_neutral?: number;
    neutral_on_missing?: boolean;
  }
) {
  const src = row && typeof row === 'object' ? row : {};
  const source = normalizeSource(src.source, idx);
  const tags = Array.isArray(src.tags)
    ? src.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
    : [];
  const hasTrit = Object.prototype.hasOwnProperty.call(src, 'trit');
  let trit = hasTrit ? normalizeTrit(src.trit) : TRIT_UNKNOWN;
  if (!hasTrit && opts.neutral_on_missing !== false) tags.push('missing_trit_neutralized');

  const baseWeight = clampNumber(src.weight, 0.0001, 1000, defaultWeight);
  let confidence = clampNumber(src.confidence, 0, 1, 1);
  const minConf = clampNumber(opts.min_confidence_for_non_neutral, 0, 1, 0);
  if (trit !== TRIT_UNKNOWN && confidence < minConf) {
    trit = TRIT_UNKNOWN;
    tags.push('low_confidence_neutralized');
  }

  const trustFloor = clampNumber(opts.source_trust_floor, 0.01, 10, 0.6);
  const trustCeiling = clampNumber(opts.source_trust_ceiling, trustFloor, 10, 1.5);
  const trust = clampNumber(
    sourceTrustValue(opts.source_trust, source, 1),
    trustFloor,
    trustCeiling,
    1
  );

  const signalTsMs = parseTsMs(src.ts)
    || parseTsMs(src.meta && src.meta.ts)
    || parseTsMs(src.meta && src.meta.updated_at)
    || null;
  const freshness = signalFreshnessFactor(
    signalTsMs,
    opts.now_ms == null ? null : opts.now_ms,
    clampNumber(opts.freshness_half_life_hours, 1, 24 * 365, 72)
  );

  const weighted = baseWeight * confidence * trust * freshness;
  return {
    source,
    trit,
    label: tritLabel(trit),
    weight: baseWeight,
    confidence,
    source_trust: trust,
    freshness,
    weighted,
    tags,
    meta: src.meta && typeof src.meta === 'object' ? src.meta : {}
  };
}

function classifyBeliefTrit(score: number, positiveThreshold: number, negativeThreshold: number) {
  if (score >= positiveThreshold) return TRIT_OK;
  if (score <= negativeThreshold) return TRIT_PAIN;
  return TRIT_UNKNOWN;
}

function evaluateTernaryBelief(signals: SignalInput[], opts: BeliefOptions = {}) {
  const rows = Array.isArray(signals) ? signals : [];
  const label = String(opts.label == null ? 'belief' : opts.label).trim() || 'belief';
  const defaultWeight = clampNumber(opts.default_weight, 0.0001, 1000, 1);
  const positiveThreshold = clampNumber(opts.positive_threshold, 0.01, 0.99, 0.2);
  const negativeThreshold = clampNumber(opts.negative_threshold, -0.99, -0.01, -0.2);
  const evidenceSaturationCount = clampNumber(opts.evidence_saturation_count, 1, 1000, 8);
  const sourceTrustFloor = clampNumber(opts.source_trust_floor, 0.01, 10, 0.6);
  const sourceTrustCeiling = clampNumber(opts.source_trust_ceiling, sourceTrustFloor, 10, 1.5);
  const freshnessHalfLifeHours = clampNumber(opts.freshness_half_life_hours, 1, 24 * 365, 72);
  const minNonNeutralSignals = clampNumber(opts.min_non_neutral_signals, 0, 1000, 1);
  const minNonNeutralWeight = clampNumber(opts.min_non_neutral_weight, 0, 1000, 0.9);
  const minConfidenceForNonNeutral = clampNumber(opts.min_confidence_for_non_neutral, 0, 1, 0.3);
  const forceNeutralOnInsufficientEvidence = opts.force_neutral_on_insufficient_evidence !== false;
  const nowMs = parseTsMs(opts.now_iso) || Date.now();

  const normalized = rows.map((row, idx) => normalizeSignal(
    row,
    idx,
    defaultWeight,
    {
      source_trust: opts.source_trust,
      source_trust_floor: sourceTrustFloor,
      source_trust_ceiling: sourceTrustCeiling,
      now_ms: nowMs,
      freshness_half_life_hours: freshnessHalfLifeHours,
      min_confidence_for_non_neutral: minConfidenceForNonNeutral,
      neutral_on_missing: opts.force_neutral_on_insufficient_evidence !== false
    }
  ));
  let painWeight = 0;
  let unknownWeight = 0;
  let okWeight = 0;
  let totalWeight = 0;
  let weightedSum = 0;
  let nonNeutralCount = 0;
  let nonNeutralWeight = 0;

  for (const row of normalized) {
    totalWeight += row.weighted;
    weightedSum += row.trit * row.weighted;
    if (row.trit === TRIT_PAIN) painWeight += row.weighted;
    else if (row.trit === TRIT_OK) okWeight += row.weighted;
    else unknownWeight += row.weighted;
    if (row.trit !== TRIT_UNKNOWN) {
      nonNeutralCount += 1;
      nonNeutralWeight += row.weighted;
    }
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const insufficientEvidence = (
    nonNeutralCount < minNonNeutralSignals
    || nonNeutralWeight < minNonNeutralWeight
  );
  const trit = forceNeutralOnInsufficientEvidence && insufficientEvidence
    ? TRIT_UNKNOWN
    : classifyBeliefTrit(score, positiveThreshold, negativeThreshold);
  const majority = majorityTrit(
    normalized.map((row) => row.trit),
    {
      weights: normalized.map((row) => row.weighted),
      tie_breaker: 'unknown'
    }
  );
  const consensus = consensusTrit(normalized.map((row) => row.trit)) === trit && trit !== TRIT_UNKNOWN;
  const evidenceCoverage = Math.min(1, normalized.length / evidenceSaturationCount);
  const concentration = totalWeight > 0 ? Math.max(painWeight, unknownWeight, okWeight) / totalWeight : 0;
  const confidence = Math.min(
    1,
    (Math.abs(score) * 0.45) + (concentration * 0.35) + (evidenceCoverage * 0.2)
  );

  const topSources = normalized
    .slice()
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 8)
    .map((row) => ({
      source: row.source,
      label: row.label,
      trit: row.trit,
      weighted: roundTo(row.weighted, 4)
    }));

  return {
    schema_id: 'ternary_belief',
    schema_version: '1.0.0',
    label,
    trit,
    trit_label: tritLabel(trit),
    score: roundTo(score, 4),
    confidence: roundTo(confidence, 4),
    consensus,
    majority_trit: majority,
    majority_label: tritLabel(majority),
    evidence_count: normalized.length,
    total_weight: roundTo(totalWeight, 4),
    support: {
      pain_weight: roundTo(painWeight, 4),
      unknown_weight: roundTo(unknownWeight, 4),
      ok_weight: roundTo(okWeight, 4)
    },
    thresholds: {
      positive: roundTo(positiveThreshold, 4),
      negative: roundTo(negativeThreshold, 4)
    },
    evidence_guard: {
      force_neutral_on_insufficient_evidence: forceNeutralOnInsufficientEvidence,
      min_non_neutral_signals: Number(minNonNeutralSignals),
      min_non_neutral_weight: roundTo(minNonNeutralWeight, 4),
      non_neutral_signals: nonNeutralCount,
      non_neutral_weight: roundTo(nonNeutralWeight, 4),
      insufficient: insufficientEvidence
    },
    weighting_model: {
      source_trust_floor: roundTo(sourceTrustFloor, 4),
      source_trust_ceiling: roundTo(sourceTrustCeiling, 4),
      freshness_half_life_hours: roundTo(freshnessHalfLifeHours, 4),
      min_confidence_for_non_neutral: roundTo(minConfidenceForNonNeutral, 4)
    },
    top_sources: topSources,
    signals: normalized.map((row) => ({
      source: row.source,
      trit: row.trit,
      label: row.label,
      weight: roundTo(row.weight, 4),
      confidence: roundTo(row.confidence, 4),
      source_trust: roundTo(row.source_trust, 4),
      freshness: roundTo(row.freshness, 4),
      weighted: roundTo(row.weighted, 4),
      tags: row.tags,
      meta: row.meta
    }))
  };
}

function mergeTernaryBeliefs(parentBelief: AnyObj, childBelief: AnyObj, opts: MergeOptions = {}) {
  const parent = parentBelief && typeof parentBelief === 'object' ? parentBelief : {};
  const child = childBelief && typeof childBelief === 'object' ? childBelief : {};
  const mode = String(opts.mode || 'cautious');
  const parentWeight = clampNumber(opts.parent_weight, 0.0001, 1000, 1);
  const childWeight = clampNumber(opts.child_weight, 0.0001, 1000, 1);
  const parentTrit = normalizeTrit(parent.trit);
  const childTrit = normalizeTrit(child.trit);
  const mergedTrit = propagateTrit(parentTrit, childTrit, { mode: mode as 'strict' | 'cautious' | 'permissive' });
  const parentScore = clampNumber(parent.score, -1, 1, parentTrit);
  const childScore = clampNumber(child.score, -1, 1, childTrit);
  const totalWeight = parentWeight + childWeight;
  const mergedScore = totalWeight > 0
    ? ((parentScore * parentWeight) + (childScore * childWeight)) / totalWeight
    : 0;
  const parentConfidence = clampNumber(parent.confidence, 0, 1, 0.5);
  const childConfidence = clampNumber(child.confidence, 0, 1, 0.5);
  const mergedConfidence = totalWeight > 0
    ? ((parentConfidence * parentWeight) + (childConfidence * childWeight)) / totalWeight
    : 0;

  return {
    schema_id: 'ternary_belief_merge',
    schema_version: '1.0.0',
    mode,
    trit: mergedTrit,
    trit_label: tritLabel(mergedTrit),
    score: roundTo(mergedScore, 4),
    confidence: roundTo(mergedConfidence, 4),
    parent: {
      trit: parentTrit,
      trit_label: tritLabel(parentTrit),
      score: roundTo(parentScore, 4),
      confidence: roundTo(parentConfidence, 4),
      weight: roundTo(parentWeight, 4)
    },
    child: {
      trit: childTrit,
      trit_label: tritLabel(childTrit),
      score: roundTo(childScore, 4),
      confidence: roundTo(childConfidence, 4),
      weight: roundTo(childWeight, 4)
    }
  };
}

function serializeBeliefResult(result: AnyObj) {
  const belief = result && typeof result === 'object' ? result : {};
  const trit = normalizeTrit(belief.trit);
  const majority = normalizeTrit(
    belief.majority_trit != null
      ? belief.majority_trit
      : belief.majority
  );
  const consensusSignal = belief.consensus === true ? trit : TRIT_UNKNOWN;
  return {
    schema_id: 'ternary_belief_serialized',
    schema_version: '1.0.0',
    trit,
    trit_label: tritLabel(trit),
    score: roundTo(belief.score, 4),
    confidence: roundTo(belief.confidence, 4),
    vector: serializeTritVector([trit, majority, consensusSignal]),
    portability: {
      target_hardware: 'balanced_ternary_ready',
      carrier_order: ['belief', 'majority', 'consensus'],
      carriers: 3
    }
  };
}

export {
  evaluateTernaryBelief,
  mergeTernaryBeliefs,
  serializeBeliefResult
};

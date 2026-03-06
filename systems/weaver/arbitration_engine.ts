#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v: unknown, maxLen = 80) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeWeights(src: AnyObj = {}) {
  return {
    impact: clampNumber(src.impact, 0, 3, 1.2),
    confidence: clampNumber(src.confidence, 0, 3, 1.05),
    uncertainty: clampNumber(src.uncertainty, 0, 3, 0.35),
    drift_risk: clampNumber(src.drift_risk, 0, 3, 1.15),
    cost_pressure: clampNumber(src.cost_pressure, 0, 3, 1.0),
    mirror_pressure: clampNumber(src.mirror_pressure, 0, 3, 0.8),
    regime_alignment: clampNumber(src.regime_alignment, 0, 3, 0.45)
  };
}

function normalizeCurrencyProfiles(src: AnyObj = {}) {
  const out: AnyObj = {};
  for (const [keyRaw, rowRaw] of Object.entries(src || {})) {
    const key = normalizeToken(keyRaw, 80);
    if (!key) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    out[key] = {
      impact_bias: clampNumber(row.impact_bias, -1, 1, 0),
      confidence_bias: clampNumber(row.confidence_bias, -1, 1, 0),
      uncertainty_bias: clampNumber(row.uncertainty_bias, -1, 1, 0),
      drift_risk_bias: clampNumber(row.drift_risk_bias, -1, 1, 0),
      cost_pressure_bias: clampNumber(row.cost_pressure_bias, -1, 1, 0),
      regime_alignment_bias: clampNumber(row.regime_alignment_bias, -1, 1, 0)
    };
  }
  return out;
}

function normalizeSoftCaps(src: unknown) {
  const rows = Array.isArray(src) ? src : [];
  const out: AnyObj[] = [];
  for (const rowRaw of rows) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const metricId = normalizeToken(row.metric_id || '', 80) || null;
    const valueCurrency = normalizeToken(row.value_currency || '', 80) || null;
    if (!metricId && !valueCurrency) continue;
    out.push({
      metric_id: metricId,
      value_currency: valueCurrency,
      max_share: clampNumber(row.max_share, 0.2, 0.95, 0.68)
    });
  }
  return out.slice(0, 24);
}

function heuristicsForMetric(row: AnyObj, context: AnyObj) {
  const metricId = normalizeToken(row.metric_id || '');
  const currency = normalizeToken(row.value_currency || '');
  const trit = clampNumber(context.trit, -1, 1, 0);
  const regimeConfidence = clampNumber(context.regime_confidence, 0, 1, 0.5);
  const mirrorPressure = clampNumber(context.mirror_pressure, 0, 1, 0);
  const autopauseActive = context.autopause_active === true;
  const objectiveImpact = clampNumber(
    context.objective_metric_impact && context.objective_metric_impact[metricId],
    -1,
    1,
    0
  );
  const profiles = normalizeCurrencyProfiles(context.currency_profiles && typeof context.currency_profiles === 'object'
    ? context.currency_profiles
    : {});
  const profile = profiles[currency] || {};

  let impact = 0.52 + (objectiveImpact * 0.45);
  let confidence = 0.55 + (trit * 0.18);
  let uncertainty = trit === 0 ? 0.65 : (trit < 0 ? 0.82 : 0.38);
  let driftRisk = 0.28;
  let costPressure = autopauseActive ? 0.6 : 0.3;
  let regimeAlignment = regimeConfidence * 0.65;

  impact += Number(profile.impact_bias || 0);
  confidence += Number(profile.confidence_bias || 0);
  uncertainty += Number(profile.uncertainty_bias || 0);
  driftRisk += Number(profile.drift_risk_bias || 0);
  costPressure += Number(profile.cost_pressure_bias || 0);
  regimeAlignment += Number(profile.regime_alignment_bias || 0);

  if (metricId === normalizeToken(context.primary_metric_hint || '')) {
    confidence += 0.06;
    impact += 0.09;
  }

  if (Array.isArray(context.mirror_reasons) && context.mirror_reasons.length > 0) {
    for (const reasonRaw of context.mirror_reasons) {
      const reason = normalizeToken(reasonRaw, 80);
      if (!reason) continue;
      if (reason.includes('yield_pressure')) impact += 0.05;
      if (reason.includes('drift')) confidence += 0.06;
      if (reason.includes('budget')) costPressure += 0.1;
    }
  }

  return {
    impact: clampNumber(impact, 0, 1, 0.5),
    confidence: clampNumber(confidence, 0, 1, 0.5),
    uncertainty: clampNumber(uncertainty, 0, 1, 0.5),
    drift_risk: clampNumber(driftRisk, 0, 1, 0.4),
    cost_pressure: clampNumber(costPressure, 0, 1, 0.4),
    mirror_pressure: clampNumber(mirrorPressure, 0, 1, 0),
    regime_alignment: clampNumber(regimeAlignment, 0, 1, 0.4)
  };
}

function normalizeShares(rows: AnyObj[]) {
  const positives = rows.map((row) => Math.max(0, Number(row.raw_score || 0) + 0.01));
  const total = positives.reduce((acc, n) => acc + n, 0);
  return rows.map((row, idx) => ({
    ...row,
    share: Number((total > 0 ? positives[idx] / total : 0).toFixed(6))
  }));
}

function enforceShareFloor(rows: AnyObj[], floorShare = 0) {
  const floor = clampNumber(floorShare, 0, 0.2, 0);
  if (floor <= 0 || !rows.length) return rows;
  let out = rows.map((row) => ({ ...row, share: Number(row.share || 0) }));
  const below = out.filter((row) => row.share < floor);
  if (!below.length) return out;
  const deficit = below.reduce((acc, row) => acc + (floor - row.share), 0);
  out = out.map((row) => (row.share < floor ? { ...row, share: floor } : row));
  let remaining = deficit;
  const donors = out
    .map((row, idx) => ({ idx, share: row.share }))
    .filter((row) => out[row.idx].share > floor)
    .sort((a, b) => b.share - a.share);
  for (const donor of donors) {
    if (remaining <= 0) break;
    const give = Math.min(remaining, out[donor.idx].share - floor);
    out[donor.idx].share = Number((out[donor.idx].share - give).toFixed(6));
    remaining = Number((remaining - give).toFixed(6));
  }
  const sum = out.reduce((acc, row) => acc + row.share, 0);
  return out.map((row) => ({
    ...row,
    share: Number((sum > 0 ? row.share / sum : 0).toFixed(6))
  }));
}

function redistributeExcess(rows: AnyObj[], cappedIdx: number, excess: number) {
  const receivers = rows
    .map((row, i) => ({ i, share: Number(row.share || 0) }))
    .filter((row) => row.i !== cappedIdx);
  if (!receivers.length || excess <= 0) return rows;
  const receiverTotal = receivers.reduce((acc, row) => acc + Math.max(row.share, 0.001), 0);
  const out = rows.map((row) => ({ ...row }));
  for (const receiver of receivers) {
    const ratio = Math.max(receiver.share, 0.001) / receiverTotal;
    out[receiver.i].share = Number((out[receiver.i].share + (excess * ratio)).toFixed(6));
  }
  const sum = out.reduce((acc, row) => acc + Number(row.share || 0), 0);
  return out.map((row) => ({
    ...row,
    share: Number((sum > 0 ? Number(row.share || 0) / sum : 0).toFixed(6))
  }));
}

function applyConfiguredSoftCaps(rows: AnyObj[], softCaps: AnyObj[]) {
  if (!Array.isArray(softCaps) || !softCaps.length) return rows;
  let out = rows.map((row) => ({ ...row }));
  for (const capRow of softCaps) {
    const cap = clampNumber(capRow && capRow.max_share, 0.2, 0.95, 0.68);
    const metricId = normalizeToken(capRow && capRow.metric_id || '', 80);
    const valueCurrency = normalizeToken(capRow && capRow.value_currency || '', 80);
    const idx = out.findIndex((row) => {
      if (!row || typeof row !== 'object') return false;
      const rowMetric = normalizeToken(row.metric_id || '', 80);
      const rowCurrency = normalizeToken(row.value_currency || '', 80);
      if (metricId && valueCurrency) return rowMetric === metricId && rowCurrency === valueCurrency;
      if (metricId) return rowMetric === metricId;
      if (valueCurrency) return rowCurrency === valueCurrency;
      return false;
    });
    if (idx === -1) continue;
    const share = Number(out[idx].share || 0);
    if (share <= cap) continue;
    const excess = share - cap;
    out[idx].share = Number(cap.toFixed(6));
    out = redistributeExcess(out, idx, excess);
  }
  return out;
}

function rankRows(rows: AnyObj[]) {
  return rows
    .slice(0)
    .sort((a, b) => Number(b.share || 0) - Number(a.share || 0));
}

function applyCombinedShareCap(rows: AnyObj[], predicate: (row: AnyObj) => boolean, maxCombinedShare: number) {
  const cap = clampNumber(maxCombinedShare, 0, 1, 0.35);
  const out = rows.map((row) => ({ ...row, share: Number(row.share || 0) }));
  const flaggedIdx = out
    .map((row, idx) => ({ idx, row }))
    .filter(({ row }) => predicate(row))
    .map(({ idx }) => idx);
  if (!flaggedIdx.length) {
    return { rows: out, adjusted: false, combined_share: 0 };
  }
  const combined = flaggedIdx.reduce((acc, idx) => acc + Math.max(0, Number(out[idx].share || 0)), 0);
  if (combined <= cap) {
    return { rows: out, adjusted: false, combined_share: Number(combined.toFixed(6)) };
  }
  const excess = combined - cap;
  for (const idx of flaggedIdx) {
    const current = Math.max(0, Number(out[idx].share || 0));
    const ratio = combined > 0 ? current / combined : 0;
    out[idx].share = Number(Math.max(0, current - (excess * ratio)).toFixed(6));
  }
  const receivers = out
    .map((row, idx) => ({ idx, share: Number(row.share || 0) }))
    .filter((row) => !flaggedIdx.includes(row.idx));
  const receiverTotal = receivers.reduce((acc, row) => acc + Math.max(row.share, 0.001), 0);
  if (receiverTotal > 0) {
    for (const receiver of receivers) {
      const ratio = Math.max(receiver.share, 0.001) / receiverTotal;
      out[receiver.idx].share = Number((Number(out[receiver.idx].share || 0) + (excess * ratio)).toFixed(6));
    }
  }
  const sum = out.reduce((acc, row) => acc + Number(row.share || 0), 0);
  const normalized = out.map((row) => ({
    ...row,
    share: Number((sum > 0 ? Number(row.share || 0) / sum : 0).toFixed(6))
  }));
  const normalizedCombined = normalized
    .filter((row) => predicate(row))
    .reduce((acc, row) => acc + Math.max(0, Number(row.share || 0)), 0);
  return {
    rows: normalized,
    adjusted: true,
    combined_share: Number(normalizedCombined.toFixed(6))
  };
}

function rankingWeightsForCurrency(currency: string, primaryMetricId = '', profiles: AnyObj = {}) {
  const cur = normalizeToken(currency || '');
  const metric = normalizeToken(primaryMetricId || '');
  const profile = profiles[cur] && typeof profiles[cur] === 'object' ? profiles[cur] : {};
  const base = {
    directive_fit: 0.19,
    actionability: 0.19,
    expected_value: 0.06,
    signal_quality: 0.16,
    time_to_value: 0.1,
    risk_penalty: 0.08
  };
  if (metric.includes('truth') || metric.includes('wisdom')) base.signal_quality += 0.04;
  if (metric.includes('joy') || metric.includes('beauty') || metric.includes('creative')) {
    base.directive_fit += 0.03;
    base.actionability -= 0.02;
  }
  for (const key of Object.keys(base)) {
    base[key as keyof typeof base] = Number(clampNumber(
      Number(base[key as keyof typeof base]) + Number(profile[key] || 0),
      0,
      1,
      Number(base[key as keyof typeof base])
    ).toFixed(4));
  }
  return base;
}

function buildStrategyOverlayFromAllocation(arbitration: AnyObj, opts: AnyObj = {}) {
  const rows = Array.isArray(arbitration && arbitration.rows) ? arbitration.rows.slice(0) : [];
  if (!rows.length) return null;
  const ordered = rankRows(rows);
  const primary = ordered[0];
  const topCurrencies = ordered
    .map((row) => normalizeToken(row.value_currency || ''))
    .filter(Boolean)
    .filter((value, idx, arr) => arr.indexOf(value) === idx)
    .slice(0, 3);
  const objectiveId = normalizeToken(opts.objective_id || '', 120) || null;
  const primaryCurrency = normalizeToken(primary && primary.value_currency || '');
  if (!primaryCurrency) return null;
  const rankingProfiles = opts.ranking_profiles && typeof opts.ranking_profiles === 'object'
    ? opts.ranking_profiles
    : {};

  const currencyOverrides: AnyObj = {};
  for (const cur of topCurrencies) {
    const hit = ordered.find((row) => normalizeToken(row.value_currency || '') === cur);
    currencyOverrides[cur] = {
      ranking_weights: rankingWeightsForCurrency(
        cur,
        hit && hit.metric_id ? String(hit.metric_id) : '',
        rankingProfiles
      )
    };
  }

  const objectiveOverrides = objectiveId
    ? {
      [objectiveId]: {
        primary_currency: primaryCurrency,
        ranking_weights: rankingWeightsForCurrency(
          primaryCurrency,
          String(primary.metric_id || ''),
          rankingProfiles
        )
      }
    }
    : {};

  return {
    default_currency: primaryCurrency,
    objective_overrides: objectiveOverrides,
    currency_overrides: currencyOverrides
  };
}

function arbitrateMetrics(input: AnyObj = {}) {
  const metrics = Array.isArray(input.metrics) ? input.metrics : [];
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  const weights = normalizeWeights(policy.weights || {});
  const floorShare = clampNumber(policy.floor_share, 0, 0.2, 0.04);
  const softCaps = normalizeSoftCaps(policy.soft_caps);
  const reasonCodes = [
    'trit_weighted_arbitration',
    'config_soft_caps_ready'
  ];
  const scored = metrics
    .map((rowRaw) => {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const metricId = normalizeToken(row.metric_id || '');
      const valueCurrency = normalizeToken(row.value_currency || '');
      if (!metricId || !valueCurrency) return null;
      const signals = heuristicsForMetric(row, context);
      const baseWeight = clampNumber(row.normalized_weight, 0, 1, 0);
      const rawScore = (
        (baseWeight * 1.2)
        + (signals.impact * weights.impact)
        + (signals.confidence * weights.confidence)
        + (signals.uncertainty * weights.uncertainty)
        + (signals.regime_alignment * weights.regime_alignment)
        - (signals.drift_risk * weights.drift_risk)
        - (signals.cost_pressure * weights.cost_pressure)
        - (signals.mirror_pressure * weights.mirror_pressure)
      );
      return {
        metric_id: metricId,
        value_currency: valueCurrency,
        normalized_weight: Number(baseWeight.toFixed(6)),
        raw_score: Number(rawScore.toFixed(6)),
        signals
      };
    })
    .filter(Boolean) as AnyObj[];

  let rows = normalizeShares(scored);
  rows = enforceShareFloor(rows, floorShare);
  rows = applyConfiguredSoftCaps(rows, softCaps);
  const allowExploration = context.allow_exploration === true;
  if (!allowExploration) {
    const uncertaintyThreshold = clampNumber(policy.exploration_uncertainty_threshold, 0, 1, 0.7);
    const maxUncertaintyShare = clampNumber(policy.max_uncertainty_exploration_share, 0, 1, 0.35);
    const uncertaintyCap = applyCombinedShareCap(
      rows,
      (row) => Number(row && row.signals && row.signals.uncertainty || 0) >= uncertaintyThreshold,
      maxUncertaintyShare
    );
    if (uncertaintyCap.adjusted) {
      rows = uncertaintyCap.rows;
      reasonCodes.push('uncertainty_exploration_capped');
    }
  }
  if (policy.block_unsafe_high_reward === true) {
    const highImpactThreshold = clampNumber(policy.unsafe_high_reward_impact_threshold, 0, 1, 0.82);
    const highDriftThreshold = clampNumber(policy.unsafe_high_reward_drift_threshold, 0, 1, 0.45);
    const maxUnsafeShare = clampNumber(policy.max_unsafe_high_reward_share, 0, 1, 0.15);
    const unsafeCap = applyCombinedShareCap(
      rows,
      (row) => (
        Number(row && row.signals && row.signals.impact || 0) >= highImpactThreshold
        && Number(row && row.signals && row.signals.drift_risk || 0) >= highDriftThreshold
      ),
      maxUnsafeShare
    );
    if (unsafeCap.adjusted) {
      rows = unsafeCap.rows;
      reasonCodes.push('unsafe_high_reward_blocked');
    }
  }
  const ordered = rankRows(rows);
  const primary = ordered[0] || null;

  return {
    rows: ordered,
    primary_metric_id: primary ? String(primary.metric_id || '') : null,
    value_currency: primary ? String(primary.value_currency || '') : null,
    reason_codes: reasonCodes,
    policy_applied: {
      floor_share: floorShare,
      soft_caps: softCaps,
      allow_exploration: allowExploration,
      max_uncertainty_exploration_share: clampNumber(policy.max_uncertainty_exploration_share, 0, 1, 0.35),
      block_unsafe_high_reward: policy.block_unsafe_high_reward === true,
      weights
    }
  };
}

module.exports = {
  arbitrateMetrics,
  buildStrategyOverlayFromAllocation
};

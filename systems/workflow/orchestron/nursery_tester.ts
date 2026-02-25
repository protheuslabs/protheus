#!/usr/bin/env node
'use strict';
export {};

const {
  clampNumber,
  normalizeScorecard,
  nowIso
} = require('./contracts');

function defaultPolicy() {
  return {
    min_safety_score: 0.62,
    max_regression_risk: 0.45,
    min_composite_score: 0.58,
    max_predicted_drift_delta: 0.01,
    min_predicted_yield_delta: -0.01,
    max_promotions_per_run: 4
  };
}

function buildPatternMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const proposalType = String(row && row.proposal_type || 'unknown').trim().toLowerCase() || 'unknown';
    map.set(proposalType, row);
  }
  return map;
}

function hasRollbackStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.id || '').toLowerCase().includes('rollback'));
}

function hasPreflightStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.id || '').toLowerCase() === 'preflight');
}

function mutationEffects(candidate) {
  const mutation = candidate && candidate.mutation && typeof candidate.mutation === 'object'
    ? candidate.mutation
    : null;
  const kind = String(mutation && mutation.kind || 'none').toLowerCase();
  if (kind === 'rollback_path') {
    return { yield_delta: 0.018, drift_delta: -0.012, safety_delta: 0.1, regression_delta: -0.07 };
  }
  if (kind === 'guard_hardening') {
    return { yield_delta: 0.014, drift_delta: -0.016, safety_delta: 0.12, regression_delta: -0.1 };
  }
  if (kind === 'retry_tuning') {
    return { yield_delta: 0.022, drift_delta: 0.004, safety_delta: -0.02, regression_delta: 0.04 };
  }
  return { yield_delta: 0.008, drift_delta: -0.006, safety_delta: 0, regression_delta: 0.01 };
}

function scoreCandidate(candidate, ctx) {
  const proposalType = String(candidate && candidate.trigger && candidate.trigger.proposal_type || 'unknown').toLowerCase();
  const pattern = ctx.patternMap.get(proposalType) || null;
  const attempts = Number(pattern && pattern.attempts || 0);
  const shipped = Number(pattern && pattern.shipped || 0);
  const noChange = Number(pattern && pattern.no_change || 0);
  const holds = Number(pattern && pattern.holds || 0);
  const stops = Number(pattern && pattern.stops || 0);
  const shippedRate = attempts > 0 ? shipped / attempts : Number(candidate && candidate.metadata && candidate.metadata.shipped_rate || 0);
  const failureRate = attempts > 0
    ? (noChange + holds + stops) / attempts
    : Number(candidate && candidate.metadata && candidate.metadata.failure_rate || 1);

  const tradeoffs = candidate && candidate.tradeoffs && typeof candidate.tradeoffs === 'object'
    ? candidate.tradeoffs
    : { speed_weight: 0.34, robustness_weight: 0.33, cost_weight: 0.33 };
  const intent = candidate && candidate.intent && typeof candidate.intent === 'object' ? candidate.intent : {};
  const signals = intent.signals && typeof intent.signals === 'object' ? intent.signals : {};

  const effects = mutationEffects(candidate);
  const uncertainty = String(intent.uncertainty_band || 'medium').toLowerCase();
  const uncertaintyPenalty = uncertainty === 'high' ? 0.11 : (uncertainty === 'medium' ? 0.05 : 0.01);
  const redTeamCritical = Number(ctx.redTeamCriticalFailures || 0);

  const predictedYieldDelta = clampNumber(
    (0.03 * shippedRate)
      - (0.015 * failureRate)
      + effects.yield_delta
      + (Number(tradeoffs.robustness_weight || 0) * 0.015)
      - (Number(tradeoffs.cost_weight || 0) * 0.008),
    -0.25,
    0.25,
    0
  );

  const predictedDriftDelta = clampNumber(
    (-0.02 * shippedRate)
      + (0.018 * failureRate)
      + effects.drift_delta
      + (Number(signals.risk || 0) < 0 ? 0.01 : -0.004)
      + (uncertainty === 'high' ? 0.01 : 0),
    -0.25,
    0.25,
    0
  );

  let safetyScore =
    (Number(ctx.principleScore || 0.5) * 0.55)
    + (hasRollbackStep(candidate) ? 0.14 : 0)
    + (hasPreflightStep(candidate) ? 0.12 : 0)
    + effects.safety_delta
    - uncertaintyPenalty
    - (redTeamCritical > 0 ? 0.1 : 0)
    + (Number(signals.feasibility || 0) > 0 ? 0.06 : 0)
    + (Number(signals.risk || 0) < 0 ? -0.04 : 0.03);
  safetyScore = clampNumber(safetyScore, 0, 1, 0);

  let regressionRisk =
    0.25
    + (1 - shippedRate) * 0.25
    + uncertaintyPenalty
    + effects.regression_delta
    + (Number(signals.risk || 0) < 0 ? 0.08 : -0.03)
    + (redTeamCritical > 0 ? 0.1 : 0)
    - (hasRollbackStep(candidate) ? 0.08 : 0)
    - (hasPreflightStep(candidate) ? 0.07 : 0);
  regressionRisk = clampNumber(regressionRisk, 0, 1, 1);

  const projectedYield = clampNumber(shippedRate + predictedYieldDelta, 0, 1, 0);
  const composite = clampNumber(
    (projectedYield * 0.42)
      + ((1 - regressionRisk) * 0.31)
      + (safetyScore * 0.27),
    0,
    1,
    0
  );

  const reasons = [];
  const policy = ctx.policy;
  if (safetyScore < policy.min_safety_score) reasons.push('safety_below_threshold');
  if (regressionRisk > policy.max_regression_risk) reasons.push('regression_risk_high');
  if (predictedDriftDelta > policy.max_predicted_drift_delta) reasons.push('predicted_drift_regression');
  if (predictedYieldDelta < policy.min_predicted_yield_delta) reasons.push('yield_lift_insufficient');
  if (composite < policy.min_composite_score) reasons.push('composite_score_low');

  return normalizeScorecard({
    candidate_id: candidate && candidate.id ? candidate.id : '',
    pass: reasons.length === 0,
    base_shipped_rate: shippedRate,
    predicted_yield_delta: predictedYieldDelta,
    predicted_drift_delta: predictedDriftDelta,
    safety_score: safetyScore,
    regression_risk: regressionRisk,
    composite_score: composite,
    reasons,
    tested_at: nowIso()
  });
}

function evaluateCandidates(input) {
  const src = input && typeof input === 'object' ? input : {};
  const policy = {
    ...defaultPolicy(),
    ...(src.policy && typeof src.policy === 'object' ? src.policy : {})
  };
  const candidates = Array.isArray(src.candidates) ? src.candidates : [];
  const patternRows = Array.isArray(src.pattern_rows) ? src.pattern_rows : [];
  const redTeam = src.red_team && typeof src.red_team === 'object' ? src.red_team : {};
  const redTeamCriticalFailures = Number(
    redTeam.critical_fail_cases
      || (redTeam.summary && redTeam.summary.critical_fail_cases)
      || 0
  );
  const principleScore = Number(src.principle_snapshot && src.principle_snapshot.score || 0.5);

  const patternMap = buildPatternMap(patternRows);
  const context = {
    policy,
    patternMap,
    redTeamCriticalFailures,
    principleScore
  };

  const scorecards = candidates.map((candidate) => scoreCandidate(candidate, context));
  scorecards.sort((a, b) => Number(b.composite_score || 0) - Number(a.composite_score || 0));

  const scoreMap = new Map(scorecards.map((row) => [String(row.candidate_id || ''), row]));
  const passing = [];
  for (const candidate of candidates) {
    const card = scoreMap.get(String(candidate && candidate.id || ''));
    if (!card || card.pass !== true) continue;
    passing.push({ candidate, scorecard: card });
  }
  passing.sort((a, b) => Number(b.scorecard.composite_score || 0) - Number(a.scorecard.composite_score || 0));

  return {
    ok: true,
    type: 'orchestron_nursery_scorecard',
    ts: nowIso(),
    policy,
    red_team_critical_failures: redTeamCriticalFailures,
    scorecards,
    passing: passing.slice(0, Math.max(1, Number(policy.max_promotions_per_run || 4)))
  };
}

module.exports = {
  evaluateCandidates
};

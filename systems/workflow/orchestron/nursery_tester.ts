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
    min_safety_score: 0.5,
    max_regression_risk: 0.56,
    min_composite_score: 0.45,
    max_predicted_drift_delta: 0.008,
    min_predicted_yield_delta: -0.005,
    min_trit_alignment: -0.7,
    max_candidate_red_team_pressure: 0.72,
    max_candidate_adversarial_critical_failures: 0,
    max_candidate_adversarial_non_critical_findings: 8,
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

function isHighPowerCandidate(candidate) {
  const proposalType = String(candidate && candidate.trigger && candidate.trigger.proposal_type || '').toLowerCase();
  if (!proposalType) return false;
  return proposalType.includes('actuation')
    || proposalType.includes('publish')
    || proposalType.includes('payment')
    || proposalType.includes('browser')
    || proposalType.includes('computer');
}

function candidateRedTeamPressure(candidate, trits, frame = {}, redTeamCriticalFailures = 0) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  const depth = Number(frame && frame.depth || 0);
  const mutationKind = String(candidate && candidate.mutation && candidate.mutation.kind || 'none').toLowerCase();
  const commandSurfaceHits = steps.filter((row) => {
    const command = String(row && row.command || '').toLowerCase();
    return command.includes('http')
      || command.includes('curl')
      || command.includes('fetch')
      || command.includes('email')
      || command.includes('publish')
      || command.includes('payment')
      || command.includes('browser')
      || command.includes('actuation')
      || command.includes('bridge')
      || command.includes('deploy')
      || command.includes('api');
  }).length;

  let pressure = 0.03;
  pressure += Math.min(0.36, Math.max(0, Number(redTeamCriticalFailures || 0)) * 0.12);
  pressure += Math.min(0.34, commandSurfaceHits * 0.07);
  pressure += isHighPowerCandidate(candidate) ? 0.22 : 0;
  pressure += hasPreflightStep(candidate) ? 0 : 0.09;
  pressure += hasRollbackStep(candidate) ? 0 : 0.1;
  pressure += clampNumber(depth * 0.025, 0, 0.2, 0);
  pressure += (trits && Number(trits.risk || 0) < 0) ? Math.abs(Number(trits.risk || 0)) * 0.14 : 0;
  pressure += (trits && Number(trits.feasibility || 0) < 0) ? Math.abs(Number(trits.feasibility || 0)) * 0.06 : 0;
  if (mutationKind === 'fractal_split') pressure += 0.08;
  if (mutationKind === 'retry_tuning') pressure += 0.05;
  if (mutationKind === 'guard_hardening') pressure -= 0.06;
  if (mutationKind === 'rollback_path') pressure -= 0.07;
  return clampNumber(pressure, 0, 1, 0);
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
  if (kind === 'fractal_split') {
    return { yield_delta: 0.016, drift_delta: -0.006, safety_delta: 0.02, regression_delta: 0.01 };
  }
  return { yield_delta: 0.008, drift_delta: -0.006, safety_delta: 0, regression_delta: 0.01 };
}

function normalizeTritSignals(intent) {
  const src = intent && intent.signals && typeof intent.signals === 'object' ? intent.signals : {};
  const feasibility = clampNumber(src.feasibility, -1, 1, 0);
  const risk = clampNumber(src.risk, -1, 1, 0);
  const novelty = clampNumber(src.novelty, -1, 1, 0);
  const alignment = Number(clampNumber(
    (feasibility * 0.42) + (risk * 0.36) + (novelty * 0.22),
    -1,
    1,
    0
  ).toFixed(4));
  return {
    feasibility,
    risk,
    novelty,
    alignment
  };
}

function normalizeValueContext(ctx) {
  const src = ctx && ctx.valueContext && typeof ctx.valueContext === 'object'
    ? ctx.valueContext
    : {};
  const weightsSrc = src.weights && typeof src.weights === 'object' ? src.weights : {};
  return {
    value_currency: String(src.value_currency || '').trim().toLowerCase() || null,
    weights: {
      expected_value: clampNumber(weightsSrc.expected_value, 0, 1, 0.1),
      actionability: clampNumber(weightsSrc.actionability, 0, 1, 0.2),
      signal_quality: clampNumber(weightsSrc.signal_quality, 0, 1, 0.15),
      risk_penalty: clampNumber(weightsSrc.risk_penalty, 0, 1, 0.05)
    }
  };
}

function flattenCandidateTree(candidates, maxDepth = 6) {
  const out = [];
  const queue = [];
  for (const row of Array.isArray(candidates) ? candidates : []) {
    if (!row || typeof row !== 'object') continue;
    queue.push({
      candidate: row,
      parent_candidate_id: row.parent_workflow_id || null,
      depth: Number(row.fractal_depth || 0)
    });
  }
  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.candidate || typeof current.candidate !== 'object') continue;
    const depth = Number(current.depth || 0);
    out.push({
      candidate: current.candidate,
      parent_candidate_id: current.parent_candidate_id || null,
      depth
    });
    if (depth >= maxDepth) continue;
    const children = Array.isArray(current.candidate.children) ? current.candidate.children : [];
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      queue.push({
        candidate: child,
        parent_candidate_id: current.candidate.id || current.parent_candidate_id || null,
        depth: depth + 1
      });
    }
  }
  return out;
}

function scoreCandidate(candidate, ctx, frame = {}) {
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
  const noChangeRate = attempts > 0
    ? noChange / attempts
    : Number(candidate && candidate.metadata && candidate.metadata.no_change_rate || failureRate);

  const tradeoffs = candidate && candidate.tradeoffs && typeof candidate.tradeoffs === 'object'
    ? candidate.tradeoffs
    : { speed_weight: 0.34, robustness_weight: 0.33, cost_weight: 0.33 };
  const intent = candidate && candidate.intent && typeof candidate.intent === 'object' ? candidate.intent : {};

  const effects = mutationEffects(candidate);
  const uncertainty = String(intent.uncertainty_band || 'medium').toLowerCase();
  const uncertaintyPenalty = uncertainty === 'high' ? 0.11 : (uncertainty === 'medium' ? 0.05 : 0.01);
  const redTeamCritical = Number(ctx.redTeamCriticalFailures || 0);
  const redTeamPressure = clampNumber(redTeamCritical > 0 ? 1 : 0, 0, 1, 0);
  const globalRedTeamPenalty = isHighPowerCandidate(candidate)
    ? (0.08 * redTeamPressure)
    : (0.02 * redTeamPressure);
  const adversarial = (
    ctx.adversarialMap instanceof Map
      ? ctx.adversarialMap.get(String(candidate && candidate.id || ''))
      : null
  ) || {};
  const adversarialCritical = Math.max(0, Number(adversarial.critical_failures || 0));
  const adversarialNonCritical = Math.max(0, Number(adversarial.non_critical_findings || 0));
  const adversarialPenalty = clampNumber(
    (adversarialCritical * 0.16) + (adversarialNonCritical * 0.02),
    0,
    0.45,
    0
  );

  const trits = normalizeTritSignals(intent);
  const candidateRedTeamPressureScore = candidateRedTeamPressure(candidate, trits, frame, redTeamCritical);
  const candidateRedTeamPenalty = candidateRedTeamPressureScore * (isHighPowerCandidate(candidate) ? 0.16 : 0.09);
  const redTeamPenalty = globalRedTeamPenalty + candidateRedTeamPenalty + adversarialPenalty;
  const tritSignal = clampNumber((trits.alignment + 1) / 2, 0, 1, 0.5);
  const depth = Number(frame && frame.depth || 0);
  const depthPenalty = clampNumber(depth * 0.025, 0, 0.2, 0);

  const predictedYieldDelta = clampNumber(
    (0.03 * shippedRate)
      - (0.015 * failureRate)
      - (0.006 * noChangeRate)
      + effects.yield_delta
      + (Number(tradeoffs.robustness_weight || 0) * 0.015)
      - (Number(tradeoffs.cost_weight || 0) * 0.008)
      + (trits.feasibility * 0.008)
      + (trits.novelty * 0.004)
      - (candidateRedTeamPenalty * 0.04)
      - depthPenalty,
    -0.25,
    0.25,
    0
  );

  const predictedDriftDelta = clampNumber(
    (-0.02 * shippedRate)
      + (0.018 * failureRate)
      + (0.01 * noChangeRate)
      + effects.drift_delta
      + (trits.risk < 0 ? 0.012 : -0.006)
      + (uncertainty === 'high' ? 0.01 : 0)
      + (candidateRedTeamPenalty * 0.06)
      + (depthPenalty * 0.6),
    -0.25,
    0.25,
    0
  );

  let safetyScore =
    (Number(ctx.principleScore || 0.5) * 0.48)
    + (hasRollbackStep(candidate) ? 0.14 : 0)
    + (hasPreflightStep(candidate) ? 0.12 : 0)
    + effects.safety_delta
    - uncertaintyPenalty
    - redTeamPenalty
    + (tritSignal * 0.14)
    - (depthPenalty * 0.5);
  safetyScore = clampNumber(safetyScore, 0, 1, 0);

  let regressionRisk =
    0.23
    + (1 - shippedRate) * 0.24
    + uncertaintyPenalty
    + effects.regression_delta
    + (trits.risk < 0 ? 0.08 : -0.03)
    + redTeamPenalty
    + (depthPenalty * 0.8)
    - (hasRollbackStep(candidate) ? 0.08 : 0)
    - (hasPreflightStep(candidate) ? 0.07 : 0);
  regressionRisk = clampNumber(regressionRisk, 0, 1, 1);

  const projectedYield = clampNumber(shippedRate + predictedYieldDelta, 0, 1, 0);
  const yieldLiftSignal = clampNumber((predictedYieldDelta + 0.015) / 0.06, 0, 1, 0);
  const driftSignal = clampNumber((0.018 - predictedDriftDelta) / 0.05, 0, 1, 0);
  const regressionSignal = clampNumber(1 - regressionRisk, 0, 1, 0);
  const valueCtx = normalizeValueContext(ctx);
  const vw = valueCtx.weights;
  const yieldWeight = 0.2 + (vw.expected_value * 0.45);
  const driftWeight = 0.16 + (vw.actionability * 0.2);
  const regressionWeight = 0.15 + (vw.risk_penalty * 0.45);
  const safetyWeight = 0.14 + (vw.signal_quality * 0.26);
  const tritWeight = 0.09 + (vw.signal_quality * 0.12) + (vw.actionability * 0.06);
  const totalWeight = Math.max(0.001, yieldWeight + driftWeight + regressionWeight + safetyWeight + tritWeight);
  const composite = clampNumber(
    (
      (yieldLiftSignal * yieldWeight)
      + (driftSignal * driftWeight)
      + (regressionSignal * regressionWeight)
      + (safetyScore * safetyWeight)
      + (tritSignal * tritWeight)
    ) / totalWeight,
    0,
    1,
    0
  );
  const compositeAdjusted = clampNumber(composite - (candidateRedTeamPenalty * 0.18), 0, 1, 0);

  const reasons = [];
  const policy = ctx.policy;
  const maxCandidateRedTeamPressure = Number.isFinite(Number(policy.max_candidate_red_team_pressure))
    ? Number(policy.max_candidate_red_team_pressure)
    : 0.72;
  const maxCandidateAdversarialCritical = Number.isFinite(Number(policy.max_candidate_adversarial_critical_failures))
    ? Number(policy.max_candidate_adversarial_critical_failures)
    : 0;
  const maxCandidateAdversarialNonCritical = Number.isFinite(Number(policy.max_candidate_adversarial_non_critical_findings))
    ? Number(policy.max_candidate_adversarial_non_critical_findings)
    : 8;
  if (safetyScore < policy.min_safety_score) reasons.push('safety_below_threshold');
  if (regressionRisk > policy.max_regression_risk) reasons.push('regression_risk_high');
  if (predictedDriftDelta > policy.max_predicted_drift_delta) reasons.push('predicted_drift_regression');
  if (predictedYieldDelta < policy.min_predicted_yield_delta) reasons.push('yield_lift_insufficient');
  if (compositeAdjusted < policy.min_composite_score) reasons.push('composite_score_low');
  if (trits.alignment < policy.min_trit_alignment) reasons.push('trit_alignment_low');
  if (candidateRedTeamPressureScore > maxCandidateRedTeamPressure) reasons.push('candidate_red_team_pressure_high');
  if (adversarialCritical > maxCandidateAdversarialCritical) reasons.push('candidate_adversarial_critical_failures');
  if (adversarialNonCritical > maxCandidateAdversarialNonCritical) reasons.push('candidate_adversarial_non_critical_findings_high');

  return normalizeScorecard({
    candidate_id: candidate && candidate.id ? candidate.id : '',
    pass: reasons.length === 0,
    base_shipped_rate: shippedRate,
    projected_yield: projectedYield,
    predicted_yield_delta: predictedYieldDelta,
    predicted_drift_delta: predictedDriftDelta,
    safety_score: safetyScore,
    regression_risk: regressionRisk,
    candidate_red_team_pressure: candidateRedTeamPressureScore,
    red_team_penalty: redTeamPenalty,
    adversarial_critical_failures: adversarialCritical,
    adversarial_non_critical_findings: adversarialNonCritical,
    adversarial_penalty: adversarialPenalty,
    adversarial_replay_artifact: adversarial && adversarial.replay_artifact_path
      ? String(adversarial.replay_artifact_path)
      : null,
    trit_alignment: trits.alignment,
    value_currency: valueCtx.value_currency,
    composite_score: compositeAdjusted,
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
  const valueContext = src.value_context && typeof src.value_context === 'object' ? src.value_context : {};
  const adversarialResults = Array.isArray(src.adversarial_results) ? src.adversarial_results : [];

  const patternMap = buildPatternMap(patternRows);
  const adversarialMap = new Map(
    adversarialResults
      .map((row) => [String(row && row.candidate_id || ''), row])
      .filter((pair) => String(pair[0] || ''))
  );
  const context = {
    policy,
    patternMap,
    redTeamCriticalFailures,
    principleScore,
    valueContext,
    adversarialMap
  };

  const flattened = flattenCandidateTree(candidates, 6);
  const scorecards = flattened.map((entry) => scoreCandidate(entry.candidate, context, entry));
  scorecards.sort((a, b) => Number(b.composite_score || 0) - Number(a.composite_score || 0));

  const scoreMap = new Map(scorecards.map((row) => [String(row.candidate_id || ''), row]));
  const passMap = new Map(scorecards.map((row) => [String(row.candidate_id || ''), row.pass === true]));
  const byId = new Map(flattened.map((row) => [String(row.candidate && row.candidate.id || ''), row]));
  const passing = [];

  for (const card of scorecards) {
    const candidateId = String(card && card.candidate_id || '');
    if (!candidateId || card.pass !== true) continue;
    const entry = byId.get(candidateId);
    if (!entry || !entry.candidate) continue;
    const parentId = String(entry.parent_candidate_id || '').trim();
    if (parentId && passMap.get(parentId) !== true) continue;
    passing.push({
      candidate: entry.candidate,
      scorecard: card,
      parent_candidate_id: parentId || null,
      depth: Number(entry.depth || 0)
    });
    if (passing.length >= Math.max(1, Number(policy.max_promotions_per_run || 4))) break;
  }

  return {
    ok: true,
    type: 'orchestron_nursery_scorecard',
    ts: nowIso(),
    policy,
    value_currency: normalizeValueContext(context).value_currency,
    red_team_critical_failures: redTeamCriticalFailures,
    adversarial_results: adversarialResults.length,
    flattened_candidates: flattened.length,
    scorecards,
    passing
  };
}

module.exports = {
  evaluateCandidates,
  flattenCandidateTree,
  normalizeTritSignals
};

#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 120) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stableId(seed, prefix = 'orc', len = 16) {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, len);
  return `${prefix}_${digest}`;
}

function trit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n >= 0.34) return 1;
  if (n <= -0.34) return -1;
  return 0;
}

function normalizeConstraints(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let speed = clampNumber(src.speed_weight, 0, 1, 0.34);
  let robustness = clampNumber(src.robustness_weight, 0, 1, 0.33);
  let cost = clampNumber(src.cost_weight, 0, 1, 0.33);
  const total = speed + robustness + cost;
  if (total > 0) {
    speed = Number((speed / total).toFixed(4));
    robustness = Number((robustness / total).toFixed(4));
    cost = Number((cost / total).toFixed(4));
  }
  return {
    speed_weight: speed,
    robustness_weight: robustness,
    cost_weight: cost
  };
}

function normalizeIntent(rawIntent, strategy) {
  const src = rawIntent && typeof rawIntent === 'object' ? rawIntent : {};
  const strategyId = String(strategy && strategy.id || src.strategy_id || 'unknown').trim() || 'unknown';
  const objective = cleanText(
    src.objective
      || (strategy && strategy.objective && strategy.objective.primary)
      || 'maximize verified progress under active directives',
    280
  );
  const uncertaintyRaw = String(src.uncertainty_band || '').trim().toLowerCase();
  const uncertainty = uncertaintyRaw === 'low' || uncertaintyRaw === 'medium' || uncertaintyRaw === 'high'
    ? uncertaintyRaw
    : 'medium';
  const constraints = normalizeConstraints(src.constraints);
  const signals = src.signals && typeof src.signals === 'object' ? src.signals : {};
  const normalizedSignals = {
    feasibility: trit(signals.feasibility),
    risk: trit(signals.risk),
    novelty: trit(signals.novelty)
  };
  const signature = normalizeToken(`${objective}|${strategyId}|${uncertainty}|${JSON.stringify(constraints)}|${JSON.stringify(normalizedSignals)}`, 180);
  return {
    id: stableId(signature, 'intent', 14),
    strategy_id: strategyId,
    objective,
    uncertainty_band: uncertainty,
    constraints,
    signals: normalizedSignals,
    source: cleanText(src.source || 'orchestron_intent_analyzer', 80),
    ts: cleanText(src.ts || nowIso(), 64),
    signature
  };
}

function normalizeStep(rawStep, index) {
  const src = rawStep && typeof rawStep === 'object' ? rawStep : {};
  const fallbackId = `step_${index + 1}`;
  const stepId = normalizeToken(src.id || fallbackId, 60) || fallbackId;
  const type = normalizeToken(src.type || 'command', 24) || 'command';
  return {
    id: stepId,
    type,
    command: cleanText(src.command || '', 260),
    purpose: cleanText(src.purpose || '', 200),
    timeout_ms: clampInt(src.timeout_ms, 500, 30 * 60 * 1000, 120000),
    retries: clampInt(src.retries, 0, 6, 1)
  };
}

function normalizeCandidate(rawCandidate, index = 0) {
  const src = rawCandidate && typeof rawCandidate === 'object' ? rawCandidate : {};
  const stepsRaw = Array.isArray(src.steps) ? src.steps : [];
  const steps = stepsRaw.map((row, i) => normalizeStep(row, i)).filter((row) => row.command || row.type === 'receipt');
  const proposalType = normalizeToken(
    src.trigger && src.trigger.proposal_type ? src.trigger.proposal_type : src.proposal_type || 'unknown',
    80
  ) || 'unknown';
  const idSeed = `${src.id || ''}|${src.strategy_id || ''}|${proposalType}|${index}`;
  const id = normalizeToken(src.id || '', 48) || stableId(idSeed, 'wfc', 16);
  const intent = normalizeIntent(src.intent, { id: src.strategy_id || 'unknown', objective: { primary: src.objective_primary || '' } });
  return {
    id,
    name: cleanText(src.name || `Orchestron candidate ${index + 1}`, 120),
    status: String(src.status || 'draft').toLowerCase() === 'active' ? 'active' : 'draft',
    source: cleanText(src.source || 'orchestron_candidate_generator', 80),
    strategy_id: cleanText(src.strategy_id || intent.strategy_id || 'unknown', 80),
    objective_id: src.objective_id ? cleanText(src.objective_id, 120) : null,
    objective_primary: cleanText(src.objective_primary || intent.objective, 240),
    trigger: {
      proposal_type: proposalType,
      min_occurrences: clampInt(src.trigger && src.trigger.min_occurrences, 1, 10000, 2),
      intent_signature: cleanText(src.trigger && src.trigger.intent_signature || intent.signature, 180)
    },
    intent,
    mutation: src.mutation && typeof src.mutation === 'object'
      ? {
          kind: normalizeToken(src.mutation.kind || 'none', 48) || 'none',
          parent_workflow_id: src.mutation.parent_workflow_id ? cleanText(src.mutation.parent_workflow_id, 80) : null,
          rationale: cleanText(src.mutation.rationale || '', 220)
        }
      : null,
    tradeoffs: normalizeConstraints(src.tradeoffs),
    risk_policy: {
      max_risk_per_action: clampInt(src.risk_policy && src.risk_policy.max_risk_per_action, 1, 100, 35),
      allowed_risks: Array.isArray(src.risk_policy && src.risk_policy.allowed_risks)
        ? src.risk_policy.allowed_risks.map((row) => normalizeToken(row, 20)).filter(Boolean).slice(0, 4)
        : ['low']
    },
    steps,
    generated_at: cleanText(src.generated_at || nowIso(), 64),
    metadata: src.metadata && typeof src.metadata === 'object' ? src.metadata : {}
  };
}

function normalizeScorecard(rawScorecard) {
  const src = rawScorecard && typeof rawScorecard === 'object' ? rawScorecard : {};
  return {
    candidate_id: cleanText(src.candidate_id || '', 80),
    pass: src.pass === true,
    base_shipped_rate: clampNumber(src.base_shipped_rate, 0, 1, 0),
    predicted_yield_delta: Number(clampNumber(src.predicted_yield_delta, -1, 1, 0).toFixed(4)),
    predicted_drift_delta: Number(clampNumber(src.predicted_drift_delta, -1, 1, 0).toFixed(4)),
    safety_score: Number(clampNumber(src.safety_score, 0, 1, 0).toFixed(4)),
    regression_risk: Number(clampNumber(src.regression_risk, 0, 1, 1).toFixed(4)),
    composite_score: Number(clampNumber(src.composite_score, 0, 1, 0).toFixed(4)),
    reasons: Array.isArray(src.reasons)
      ? src.reasons.map((row) => cleanText(row, 120)).filter(Boolean).slice(0, 8)
      : [],
    tested_at: cleanText(src.tested_at || nowIso(), 64)
  };
}

function toWorkflowDraft(candidate, scorecard, context = {}) {
  const c = normalizeCandidate(candidate, 0);
  const s = normalizeScorecard({ ...scorecard, candidate_id: c.id });
  const principles = context.principles && typeof context.principles === 'object' ? context.principles : {};
  const score = Number(clampNumber(s.composite_score, 0, 1, 0).toFixed(4));
  return {
    id: c.id,
    name: c.name,
    status: 'draft',
    source: 'orchestron_adaptive_controller',
    strategy_id: c.strategy_id,
    objective_id: c.objective_id,
    objective_primary: c.objective_primary,
    trigger: c.trigger,
    intent: c.intent,
    mutation: c.mutation,
    principles: {
      score: clampNumber(principles.score, 0, 1, 0.5),
      band: cleanText(principles.band || 'unknown', 32),
      ids: Array.isArray(principles.ids) ? principles.ids.slice(0, 8) : []
    },
    metrics: {
      attempts: Number(c.metadata && c.metadata.attempts || 0),
      shipped_rate: Number(clampNumber(s.base_shipped_rate, 0, 1, 0).toFixed(4)),
      failure_rate: Number(clampNumber(c.metadata && c.metadata.failure_rate, 0, 1, 1).toFixed(4)),
      score,
      predicted_yield_delta: s.predicted_yield_delta,
      predicted_drift_delta: s.predicted_drift_delta,
      safety_score: s.safety_score,
      regression_risk: s.regression_risk,
      scorecard_pass: s.pass
    },
    risk_policy: c.risk_policy,
    steps: c.steps,
    generated_at: nowIso()
  };
}

module.exports = {
  nowIso,
  clampInt,
  clampNumber,
  cleanText,
  normalizeToken,
  stableId,
  normalizeIntent,
  normalizeStep,
  normalizeCandidate,
  normalizeScorecard,
  toWorkflowDraft
};

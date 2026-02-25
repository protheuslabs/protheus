#!/usr/bin/env node
'use strict';
export {};

const { runLocalOllamaPrompt } = require('../../routing/llm_gateway');
const {
  stableId,
  cleanText,
  normalizeToken,
  clampInt,
  clampNumber,
  normalizeCandidate
} = require('./contracts');

function nowIso() {
  return new Date().toISOString();
}

function skillBridgeStepForProposalType(proposalType) {
  const p = String(proposalType || '').trim().toLowerCase();
  if (p.includes('publish') || p.includes('moltbook')) {
    return {
      id: 'skill_publish_bridge',
      type: 'command',
      command: 'node memory/tools/skill_runner.js skills/moltbook/moltbook_publish_guard.js --dry-run',
      purpose: 'run skill-backed publish adapter (temporary integration bridge)',
      timeout_ms: 180000,
      retries: 1
    };
  }
  if (p.includes('email') || p.includes('outreach') || p.includes('reply')) {
    return {
      id: 'skill_comms_bridge',
      type: 'command',
      command: 'node memory/tools/skill_runner.js skills/imap-smtp-email/scripts/smtp.js --dry-run',
      purpose: 'run skill-backed communication adapter (temporary integration bridge)',
      timeout_ms: 180000,
      retries: 1
    };
  }
  if (p.includes('external') || p.includes('reddit') || p.includes('collector')) {
    return {
      id: 'skill_collect_bridge',
      type: 'command',
      command: 'node memory/tools/skill_runner.js skills/reddit-readonly/scripts/reddit-readonly.mjs --help',
      purpose: 'run skill-backed source adapter (temporary integration bridge)',
      timeout_ms: 180000,
      retries: 1
    };
  }
  return null;
}

function addSkillBridge(steps, proposalType) {
  const bridge = skillBridgeStepForProposalType(proposalType);
  if (!bridge) return steps;
  const out = Array.isArray(steps) ? steps.slice() : [];
  const receiptIdx = out.findIndex((row) => String(row && row.type || '').toLowerCase() === 'receipt');
  if (receiptIdx === -1) out.push(bridge);
  else out.splice(receiptIdx, 0, bridge);
  return out;
}

function defaultStepsForProposalType(proposalType) {
  const p = String(proposalType || '').trim().toLowerCase();
  if (p.includes('collector') || p.includes('external')) {
    return addSkillBridge([
      { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=<eye_id>', purpose: 'collect external signal', timeout_ms: 180000, retries: 1 },
      { id: 'ingest', type: 'command', command: 'node habits/scripts/sensory_queue.js ingest <date>', purpose: 'normalize and queue proposals', timeout_ms: 120000, retries: 1 },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce execution safety gates', timeout_ms: 120000, retries: 0 },
      { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record verifiable outcome', timeout_ms: 30000, retries: 0 }
    ], p);
  }
  if (p.includes('actuation') || p.includes('publish')) {
    return addSkillBridge([
      { id: 'bridge', type: 'command', command: 'node systems/actuation/bridge_from_proposals.js run <date>', purpose: 'proposal to actuation contract', timeout_ms: 180000, retries: 1 },
      { id: 'execute', type: 'command', command: 'node systems/actuation/actuation_executor.js run --kind=<adapter> --dry-run', purpose: 'execute safely via adapter', timeout_ms: 240000, retries: 1 },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'postcondition and rollback checks', timeout_ms: 120000, retries: 0 },
      { id: 'receipt', type: 'receipt', command: 'state/actuation/receipts/<date>.jsonl', purpose: 'record receipt evidence', timeout_ms: 30000, retries: 0 }
    ], p);
  }
  return addSkillBridge([
    { id: 'enrich', type: 'command', command: 'node systems/autonomy/proposal_enricher.js run <date>', purpose: 'normalize proposal shape', timeout_ms: 120000, retries: 1 },
    { id: 'rank', type: 'command', command: 'node systems/autonomy/autonomy_controller.js run <date>', purpose: 'rank and execute/preview', timeout_ms: 180000, retries: 1 },
    { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce safety and evidence checks', timeout_ms: 120000, retries: 0 },
    { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record final receipt evidence', timeout_ms: 30000, retries: 0 }
  ], p);
}

function cloneSteps(steps) {
  return Array.isArray(steps)
    ? steps.map((row) => ({ ...row }))
    : [];
}

function hasStep(steps, predicate) {
  for (const row of steps || []) {
    if (predicate(row)) return true;
  }
  return false;
}

function insertBeforeReceipt(steps, step) {
  const out = cloneSteps(steps);
  const receiptIdx = out.findIndex((row) => String(row.type || '').toLowerCase() === 'receipt');
  if (receiptIdx === -1) out.push(step);
  else out.splice(receiptIdx, 0, step);
  return out;
}

function mutateSteps(baseSteps, mutationKind) {
  const steps = cloneSteps(baseSteps);
  const kind = String(mutationKind || '').trim().toLowerCase();
  if (!steps.length) return steps;

  if (kind === 'guard_hardening') {
    if (!hasStep(steps, (row) => String(row.id || '').toLowerCase() === 'preflight')) {
      return insertBeforeReceipt(steps, {
        id: 'preflight',
        type: 'gate',
        command: 'node systems/spine/contract_check.js',
        purpose: 'preflight contract guard',
        timeout_ms: 60000,
        retries: 0
      });
    }
    return steps;
  }

  if (kind === 'rollback_path') {
    if (!hasStep(steps, (row) => String(row.id || '').toLowerCase().includes('rollback'))) {
      return insertBeforeReceipt(steps, {
        id: 'rollback',
        type: 'command',
        command: 'node systems/autonomy/strategy_execute_guard.js rollback <date>',
        purpose: 'bounded rollback path for failed step verification',
        timeout_ms: 90000,
        retries: 0
      });
    }
    return steps;
  }

  if (kind === 'retry_tuning') {
    return steps.map((row) => {
      const type = String(row.type || '').toLowerCase();
      if (type !== 'command') return row;
      return {
        ...row,
        retries: clampInt(Number(row.retries || 1) + 1, 0, 4, 2),
        timeout_ms: clampInt(Number(row.timeout_ms || 120000) + 15000, 500, 30 * 60 * 1000, 135000)
      };
    });
  }

  if (kind === 'fractal_split') {
    if (hasStep(steps, (row) => String(row.id || '').toLowerCase() === 'spawn_subworkflow')) return steps;
    return insertBeforeReceipt(steps, {
      id: 'spawn_subworkflow',
      type: 'command',
      command: 'node systems/workflow/orchestron_controller.js run <date> --orchestron=1 --orchestron-auto=1',
      purpose: 'spawn focused sub-workflows for pressure lanes',
      timeout_ms: 120000,
      retries: 0
    });
  }

  return steps;
}

function normalizeTradeoffs(tradeoffs) {
  const src = tradeoffs && typeof tradeoffs === 'object' ? tradeoffs : {};
  const speed = Number(src.speed_weight || 0.34);
  const robust = Number(src.robustness_weight || 0.33);
  const cost = Number(src.cost_weight || 0.33);
  const sum = (speed > 0 ? speed : 0) + (robust > 0 ? robust : 0) + (cost > 0 ? cost : 0);
  if (sum <= 0) return { speed_weight: 0.34, robustness_weight: 0.33, cost_weight: 0.33 };
  return {
    speed_weight: Number(((speed > 0 ? speed : 0) / sum).toFixed(4)),
    robustness_weight: Number(((robust > 0 ? robust : 0) / sum).toFixed(4)),
    cost_weight: Number(((cost > 0 ? cost : 0) / sum).toFixed(4))
  };
}

function tradeoffForMutation(baseTradeoff, mutationKind) {
  const t = normalizeTradeoffs(baseTradeoff);
  const kind = String(mutationKind || '').toLowerCase();
  if (kind === 'guard_hardening' || kind === 'rollback_path') {
    return normalizeTradeoffs({
      speed_weight: t.speed_weight * 0.85,
      robustness_weight: t.robustness_weight * 1.25,
      cost_weight: t.cost_weight * 0.9
    });
  }
  if (kind === 'retry_tuning') {
    return normalizeTradeoffs({
      speed_weight: t.speed_weight * 0.9,
      robustness_weight: t.robustness_weight * 1.05,
      cost_weight: t.cost_weight * 1.1
    });
  }
  if (kind === 'fractal_split') {
    return normalizeTradeoffs({
      speed_weight: t.speed_weight * 0.95,
      robustness_weight: t.robustness_weight * 1.1,
      cost_weight: t.cost_weight * 0.95
    });
  }
  return t;
}

function tritContext(intent) {
  const signals = intent && intent.signals && typeof intent.signals === 'object' ? intent.signals : {};
  const feasibility = clampNumber(signals.feasibility, -1, 1, 0);
  const risk = clampNumber(signals.risk, -1, 1, 0);
  const novelty = clampNumber(signals.novelty, -1, 1, 0);
  const alignment = Number(clampNumber(
    (feasibility * 0.42) + (risk * 0.36) + (novelty * 0.22),
    -1,
    1,
    0
  ).toFixed(4));
  return { feasibility, risk, novelty, alignment };
}

function patternRates(row) {
  const attempts = Number(row && row.attempts || 0);
  const shipped = Number(row && row.shipped || 0);
  const noChange = Number(row && row.no_change || 0);
  const holds = Number(row && row.holds || 0);
  const stops = Number(row && row.stops || 0);
  return {
    attempts,
    shipped_rate: attempts > 0 ? shipped / attempts : 0,
    no_change_rate: attempts > 0 ? noChange / attempts : 0,
    failure_rate: attempts > 0 ? (noChange + holds + stops) / attempts : 1
  };
}

function normalizeValueContext(ctx) {
  const src = ctx && ctx.value_context && typeof ctx.value_context === 'object'
    ? ctx.value_context
    : {};
  const weightsSrc = src.weights && typeof src.weights === 'object' ? src.weights : {};
  return {
    value_currency: normalizeToken(src.value_currency || '', 40) || null,
    weights: {
      expected_value: clampNumber(weightsSrc.expected_value, 0, 1, 0.1),
      actionability: clampNumber(weightsSrc.actionability, 0, 1, 0.2),
      signal_quality: clampNumber(weightsSrc.signal_quality, 0, 1, 0.15),
      risk_penalty: clampNumber(weightsSrc.risk_penalty, 0, 1, 0.05)
    }
  };
}

function valuePriorityContext(rates, trits, ctx) {
  const valueCtx = normalizeValueContext(ctx);
  const weights = valueCtx.weights;
  const weightTotal = Math.max(
    0.001,
    Number(weights.expected_value || 0)
      + Number(weights.actionability || 0)
      + Number(weights.signal_quality || 0)
      + Number(weights.risk_penalty || 0)
  );
  const expectedSignal = clampNumber(rates && rates.shipped_rate, 0, 1, 0);
  const actionSignal = clampNumber(1 - Number(rates && rates.no_change_rate || 0), 0, 1, 0);
  const signalQuality = clampNumber(1 - Number(rates && rates.failure_rate || 1), 0, 1, 0);
  const riskSignal = clampNumber(
    (Number(rates && rates.failure_rate || 0) * 0.5)
      + ((trits && trits.risk < 0) ? 0.5 : 0),
    0,
    1,
    0
  );
  const weighted =
    (expectedSignal * Number(weights.expected_value || 0))
    + (actionSignal * Number(weights.actionability || 0))
    + (signalQuality * Number(weights.signal_quality || 0))
    - (riskSignal * Number(weights.risk_penalty || 0));
  const normalized = clampNumber(0.5 + ((weighted / weightTotal) - 0.5), 0, 1, 0.5);
  return {
    value_currency: valueCtx.value_currency,
    score: Number(normalized.toFixed(4))
  };
}

function normalizeFractalPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    max_depth: clampInt(src.max_depth, 1, 6, 3),
    max_children_per_workflow: clampInt(src.max_children_per_workflow, 1, 8, 3),
    min_attempts_for_split: clampInt(src.min_attempts_for_split, 1, 100000, 4),
    min_failure_rate_for_split: clampNumber(src.min_failure_rate_for_split, 0, 1, 0.45)
  };
}

function normalizeRuntimeEvolutionPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    max_candidates: clampInt(src.max_candidates, 0, 24, 3),
    failure_pressure_min: clampNumber(src.failure_pressure_min, 0, 1, 0.45),
    no_change_pressure_min: clampNumber(src.no_change_pressure_min, 0, 1, 0.35)
  };
}

function shouldSplitFractal(row, ctx) {
  const fractal = normalizeFractalPolicy(ctx && ctx.fractal);
  if (fractal.enabled !== true) return false;
  const rates = patternRates(row);
  if (rates.attempts < fractal.min_attempts_for_split) return false;
  const t = tritContext(ctx && ctx.intent);
  if (rates.failure_rate >= fractal.min_failure_rate_for_split) return true;
  if (rates.no_change_rate >= fractal.min_failure_rate_for_split * 0.85) return true;
  if (t.novelty > 0 && rates.attempts >= fractal.min_attempts_for_split + 1) return true;
  return false;
}

function fractalChildTemplates() {
  return [
    { key: 'intake', purpose: 'specialize intake and directive normalization' },
    { key: 'execution', purpose: 'specialize execution branch and fallback routing' },
    { key: 'verification', purpose: 'specialize verification + receipt hardening' },
    { key: 'economy', purpose: 'specialize cost governance and budget fit' }
  ];
}

function spawnFractalChildren(parentCandidate, row, ctx, seedSuffix = 'split') {
  const fractal = normalizeFractalPolicy(ctx && ctx.fractal);
  if (fractal.enabled !== true) return [];
  const parent = parentCandidate && typeof parentCandidate === 'object' ? parentCandidate : {};
  const parentDepth = clampInt(parent.fractal_depth, 0, 12, 0);
  if (parentDepth + 1 > fractal.max_depth) return [];
  const proposalType = normalizeToken(parent.trigger && parent.trigger.proposal_type || row && row.proposal_type || 'unknown', 80) || 'unknown';
  const rates = patternRates(row);
  const trits = tritContext(ctx && ctx.intent);
  const value = valuePriorityContext(rates, trits, ctx);
  const templates = fractalChildTemplates();
  const count = clampInt(Math.min(fractal.max_children_per_workflow, templates.length), 1, templates.length, 2);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const lane = templates[i];
    const childProposalType = normalizeToken(`${proposalType}.${lane.key}`, 80) || proposalType;
    const childSeed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|${parent.id}|${seedSuffix}|${childProposalType}|${i}`;
    const child = normalizeCandidate({
      id: stableId(childSeed, 'wfc', 16),
      name: `${cleanText(parent.name || proposalType, 72)} :: ${lane.key}`,
      status: 'draft',
      source: parent.source || 'orchestron_candidate_generator',
      strategy_id: parent.strategy_id || ctx.strategy_id,
      objective_id: parent.objective_id || row && row.recent_objective_id || null,
      objective_primary: parent.objective_primary || ctx.objective_primary,
      trigger: {
        proposal_type: childProposalType,
        min_occurrences: clampInt(parent.trigger && parent.trigger.min_occurrences, 1, 10000, 2),
        intent_signature: ctx.intent.signature
      },
      parent_workflow_id: parent.id || null,
      fractal_depth: parentDepth + 1,
      intent: ctx.intent,
      mutation: {
        kind: 'fractal_split',
        parent_workflow_id: parent.id || null,
        rationale: `spawned from ${proposalType} to isolate ${lane.key} pressure lane`
      },
      tradeoffs: normalizeTradeoffs(parent.tradeoffs || ctx.intent.constraints),
      risk_policy: parent.risk_policy || ctx.risk_policy,
      steps: [
        { id: 'scope', type: 'command', command: 'node systems/autonomy/proposal_enricher.js run <date>', purpose: lane.purpose, timeout_ms: 120000, retries: 1 },
        { id: 'execute_lane', type: 'command', command: 'node systems/autonomy/autonomy_controller.js run <date>', purpose: 'execute sub-workflow lane', timeout_ms: 180000, retries: 1 },
        { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'verify lane safety and evidence', timeout_ms: 120000, retries: 0 },
        { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record lane receipt', timeout_ms: 30000, retries: 0 }
      ],
      metadata: {
        generation_kind: 'fractal_child',
        parent_workflow_id: parent.id || null,
        attempts: Number(row && row.attempts || 0),
        shipped_rate: Number(row && row.shipped_rate || 0),
        failure_rate: Number(row && row.failure_rate || 1),
        intent_trit_alignment: Number(tritContext(ctx && ctx.intent).alignment || 0),
        value_currency: value.value_currency || null,
        value_priority_score: Number(value.score || 0.5),
        lane: lane.key
      },
      generated_at: nowIso()
    }, i, { depth: parentDepth + 1, maxDepth: fractal.max_depth });
    if (child) out.push(child);
  }
  return out;
}

function mutationIntentScore(kind, ctx, workflowMetrics = {}, pressure = {}) {
  const t = tritContext(ctx && ctx.intent);
  const failureRate = clampNumber(workflowMetrics.failure_rate, 0, 1, 0.5);
  const noChangeRate = clampNumber(workflowMetrics.no_change_rate, 0, 1, 0.5);
  const failurePressure = clampNumber(pressure.failure_pressure, 0, 1, failureRate);
  const noChangePressure = clampNumber(pressure.no_change_pressure, 0, 1, noChangeRate);
  const mutation = String(kind || '').toLowerCase();
  if (mutation === 'guard_hardening') {
    return Number((0.45 + (failurePressure * 0.3) + (t.risk < 0 ? 0.2 : 0.02)).toFixed(4));
  }
  if (mutation === 'rollback_path') {
    return Number((0.44 + (failurePressure * 0.25) + (t.feasibility <= 0 ? 0.12 : 0.02)).toFixed(4));
  }
  if (mutation === 'retry_tuning') {
    return Number((0.4 + (noChangePressure * 0.2) + (t.feasibility > 0 ? 0.12 : -0.05) - (t.risk < 0 ? 0.07 : 0)).toFixed(4));
  }
  if (mutation === 'fractal_split') {
    return Number((0.38 + (failurePressure * 0.2) + (noChangePressure * 0.18) + (t.novelty > 0 ? 0.16 : 0)).toFixed(4));
  }
  return 0;
}

function chooseMutationKinds(workflow, ctx = {}, pressure = {}) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const mutationCandidates = [];
  const hasRollback = hasStep(steps, (row) => String(row.id || '').toLowerCase().includes('rollback'));
  const hasPreflight = hasStep(steps, (row) => String(row.id || '').toLowerCase() === 'preflight');
  if (!hasPreflight) mutationCandidates.push('guard_hardening');
  if (!hasRollback) mutationCandidates.push('rollback_path');
  mutationCandidates.push('retry_tuning');
  mutationCandidates.push('fractal_split');
  const scored = mutationCandidates
    .map((kind) => ({
      kind,
      score: mutationIntentScore(kind, ctx, wf.metrics || {}, pressure)
    }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const row of scored) {
    if (!row || !row.kind) continue;
    if (!out.includes(row.kind)) out.push(row.kind);
    if (out.length >= 2) break;
  }
  return out;
}

function patternToCandidate(row, idx, ctx) {
  const proposalType = normalizeToken(row && row.proposal_type || 'unknown', 80) || 'unknown';
  const rates = patternRates(row);
  const t = tritContext(ctx && ctx.intent);
  const value = valuePriorityContext(rates, t, ctx);
  const priority = clampNumber(
    0.48
      + (value.score * 0.28)
      + (((t.alignment + 1) / 2) * 0.16)
      + ((1 - rates.failure_rate) * 0.08),
    0.2,
    0.98,
    0.72
  );
  const seed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|${proposalType}|pattern|${idx}`;
  const candidate = normalizeCandidate({
    id: stableId(seed, 'wfc', 16),
    name: `Adaptive ${proposalType} workflow`,
    status: 'draft',
    source: 'orchestron_candidate_generator',
    strategy_id: ctx.strategy_id,
    objective_id: row && row.recent_objective_id ? String(row.recent_objective_id) : null,
    objective_primary: ctx.objective_primary,
    trigger: {
      proposal_type: proposalType,
      min_occurrences: Math.max(2, Math.floor(Math.min(12, rates.attempts / 2))),
      intent_signature: ctx.intent.signature
    },
    intent: ctx.intent,
    parent_workflow_id: null,
    fractal_depth: 0,
    mutation: null,
    tradeoffs: ctx.intent.constraints,
    risk_policy: ctx.risk_policy,
    steps: defaultStepsForProposalType(proposalType),
    metadata: {
      generation_kind: 'pattern',
      priority: Number(priority.toFixed(4)),
      attempts: rates.attempts,
      shipped_rate: Number(rates.shipped_rate.toFixed(4)),
      failure_rate: Number(rates.failure_rate.toFixed(4)),
      no_change_rate: Number(rates.no_change_rate.toFixed(4)),
      intent_trit_alignment: Number(t.alignment.toFixed(4)),
      value_currency: value.value_currency || null,
      value_priority_score: Number(value.score || 0.5)
    },
    generated_at: nowIso()
  }, idx, {
    depth: 0,
    maxDepth: clampInt(ctx.fractal && ctx.fractal.max_depth, 1, 6, 3)
  });

  if (candidate && shouldSplitFractal({ ...row, ...rates }, ctx)) {
    candidate.children = spawnFractalChildren(candidate, { ...row, ...rates }, ctx, 'pattern');
    candidate.metadata = {
      ...(candidate.metadata || {}),
      fractal_children_count: Array.isArray(candidate.children) ? candidate.children.length : 0
    };
  }

  return candidate;
}

function workflowToMutationCandidate(workflow, mutationKind, idx, ctx, extras = {}) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const proposalType = normalizeToken(wf.trigger && wf.trigger.proposal_type || 'unknown', 80) || 'unknown';
  const parentId = String(wf.id || '').trim();
  const seed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|${parentId}|${mutationKind}|${idx}|${extras.generation_kind || 'mutation'}`;
  const baseSteps = Array.isArray(wf.steps) ? wf.steps : defaultStepsForProposalType(proposalType);
  const steps = mutateSteps(baseSteps, mutationKind);
  const mutation = {
    kind: mutationKind,
    parent_workflow_id: parentId,
    rationale: mutationKind === 'rollback_path'
      ? 'add deterministic rollback path for failed verifications'
      : (mutationKind === 'guard_hardening'
        ? 'insert preflight contract guard before receipt'
        : (mutationKind === 'fractal_split'
          ? 'split into focused sub-workflows to isolate pressure lanes'
          : 'tune retries/timeouts for transient instability'))
  };
  const metrics = wf.metrics && typeof wf.metrics === 'object' ? wf.metrics : {};
  const pressure = extras.pressure && typeof extras.pressure === 'object' ? extras.pressure : {};
  const rates = {
    shipped_rate: clampNumber(metrics.shipped_rate, 0, 1, 0),
    failure_rate: clampNumber(metrics.failure_rate, 0, 1, 1),
    no_change_rate: clampNumber(pressure.no_change_pressure, 0, 1, 0)
  };
  const trits = tritContext(ctx && ctx.intent);
  const value = valuePriorityContext(rates, trits, ctx);
  const priority = clampNumber(
    0.4
      + (Number(pressure.failure_pressure || 0) * 0.16)
      + (Number(pressure.no_change_pressure || 0) * 0.12)
      + (value.score * 0.22),
    0.35,
    0.95,
    0.68
  );
  const candidate = normalizeCandidate({
    id: stableId(seed, 'wfc', 16),
    name: `${cleanText(wf.name || parentId || 'workflow', 80)} (${mutationKind})`,
    status: 'draft',
    source: 'orchestron_candidate_generator',
    strategy_id: ctx.strategy_id,
    objective_id: wf.objective_id ? String(wf.objective_id) : null,
    objective_primary: cleanText(wf.objective_primary || ctx.objective_primary, 240),
    trigger: {
      proposal_type: proposalType,
      min_occurrences: Number(wf.trigger && wf.trigger.min_occurrences || 2),
      intent_signature: ctx.intent.signature
    },
    intent: ctx.intent,
    parent_workflow_id: null,
    fractal_depth: clampInt(wf.fractal_depth, 0, 12, 0),
    mutation,
    tradeoffs: tradeoffForMutation(ctx.intent.constraints, mutationKind),
    risk_policy: wf.risk_policy || ctx.risk_policy,
    steps,
    metadata: {
      generation_kind: extras.generation_kind || 'mutation',
      priority: Number(priority.toFixed(4)),
      attempts: Number(metrics.attempts || 0),
      shipped_rate: Number(metrics.shipped_rate || 0),
      failure_rate: Number(metrics.failure_rate || 0),
      no_change_rate: Number(pressure.no_change_pressure || 0),
      intent_trit_alignment: Number(trits.alignment || 0),
      value_currency: value.value_currency || null,
      value_priority_score: Number(value.score || 0.5)
    },
    generated_at: nowIso()
  }, idx, {
    depth: clampInt(wf.fractal_depth, 0, 12, 0),
    maxDepth: clampInt(ctx.fractal && ctx.fractal.max_depth, 1, 6, 3)
  });

  if (candidate && mutationKind === 'fractal_split') {
    const row = {
      proposal_type: proposalType,
      attempts: Number(metrics.attempts || 0),
      shipped: Math.round(Number(metrics.shipped_rate || 0) * Number(metrics.attempts || 0)),
      no_change: Math.round(Number(metrics.failure_rate || 0) * Number(metrics.attempts || 0)),
      holds: 0,
      stops: 0,
      recent_objective_id: wf.objective_id || null
    };
    candidate.children = spawnFractalChildren(candidate, { ...row, ...patternRates(row) }, ctx, extras.generation_kind || 'mutation');
    candidate.metadata = {
      ...(candidate.metadata || {}),
      fractal_children_count: Array.isArray(candidate.children) ? candidate.children.length : 0
    };
  }
  return candidate;
}

function normalizeCreativePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    model: cleanText(src.model || process.env.ORCHESTRON_CREATIVE_LLM_MODEL || 'qwen3:4b', 80),
    timeout_ms: clampInt(src.timeout_ms, 300, 30000, 2500),
    max_candidates: clampInt(src.max_candidates, 1, 12, 3),
    min_novelty_trit: clampInt(src.min_novelty_trit, -1, 1, 0),
    cache_ttl_ms: clampInt(src.cache_ttl_ms, 0, 24 * 60 * 60 * 1000, 10 * 60 * 1000)
  };
}

function extractJsonBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const starts = [];
  const firstObj = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  if (firstObj >= 0) starts.push(firstObj);
  if (firstArr >= 0) starts.push(firstArr);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  for (let end = raw.length; end > start; end -= 1) {
    const chunk = raw.slice(start, end).trim();
    if (!(chunk.startsWith('{') || chunk.startsWith('['))) continue;
    try {
      return JSON.parse(chunk);
    } catch {}
  }
  return null;
}

function summarizePatternRows(rows, maxRows = 5) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, maxRows) : []) {
    const rates = patternRates(row);
    out.push({
      proposal_type: normalizeToken(row && row.proposal_type || 'unknown', 80) || 'unknown',
      attempts: rates.attempts,
      shipped_rate: Number(rates.shipped_rate.toFixed(3)),
      failure_rate: Number(rates.failure_rate.toFixed(3)),
      no_change_rate: Number(rates.no_change_rate.toFixed(3))
    });
  }
  return out;
}

function summarizeRegistryRows(rows, maxRows = 4) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, maxRows) : []) {
    const metrics = row && row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    out.push({
      id: cleanText(row && row.id || '', 80),
      proposal_type: normalizeToken(row && row.trigger && row.trigger.proposal_type || 'unknown', 80) || 'unknown',
      attempts: Number(metrics.attempts || 0),
      shipped_rate: Number(metrics.shipped_rate || 0),
      failure_rate: Number(metrics.failure_rate || 1)
    });
  }
  return out;
}

function buildCreativePrompt(ctx, slots) {
  const t = tritContext(ctx && ctx.intent);
  const valueCtx = normalizeValueContext(ctx);
  const payload = {
    objective: ctx && ctx.intent ? ctx.intent.objective : '',
    value_currency: valueCtx.value_currency,
    value_weights: valueCtx.weights,
    trit_signals: {
      feasibility: t.feasibility,
      risk: t.risk,
      novelty: t.novelty
    },
    constraints: ctx && ctx.intent && ctx.intent.constraints ? ctx.intent.constraints : {},
    pattern_rows: summarizePatternRows(ctx && ctx.pattern_rows),
    active_workflows: summarizeRegistryRows(ctx && ctx.registry_workflows),
    max_candidates: clampInt(slots, 1, 12, 2)
  };

  return [
    'You are generating adaptive workflow candidates for Orchestron.',
    'Return STRICT JSON only (no markdown, no commentary).',
    'Schema:',
    '{"candidates":[{"name":"...", "proposal_type":"...", "objective":"...", "mutation_kind":"guard_hardening|rollback_path|retry_tuning|fractal_split|none", "min_occurrences":2, "risk":"low|medium", "steps":[{"id":"...", "type":"command|gate|receipt", "command":"...", "purpose":"..."}], "children":[{"name":"...", "proposal_type":"...", "objective":"..."}]}]}',
    'Keep steps realistic and bounded. Keep candidate count <= max_candidates.',
    JSON.stringify(payload)
  ].join('\n');
}

function creativeCandidateFromRow(row, idx, ctx) {
  const src = row && typeof row === 'object' ? row : {};
  const proposalType = normalizeToken(src.proposal_type || 'unknown', 80) || 'unknown';
  const mutationKind = normalizeToken(src.mutation_kind || 'none', 40) || 'none';
  const seed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|creative|${proposalType}|${idx}|${mutationKind}`;
  const steps = Array.isArray(src.steps) && src.steps.length
    ? src.steps.map((step, i) => ({
      id: normalizeToken(step && step.id || `step_${i + 1}`, 48) || `step_${i + 1}`,
      type: normalizeToken(step && step.type || 'command', 24) || 'command',
      command: cleanText(step && step.command || 'node systems/autonomy/autonomy_controller.js run <date>', 260),
      purpose: cleanText(step && step.purpose || 'candidate step', 200),
      timeout_ms: clampInt(step && step.timeout_ms, 500, 30 * 60 * 1000, 120000),
      retries: clampInt(step && step.retries, 0, 6, 1)
    }))
    : defaultStepsForProposalType(proposalType);
  const rates = { attempts: 0, shipped_rate: 0, failure_rate: 1, no_change_rate: 1 };
  const trits = tritContext(ctx && ctx.intent);
  const value = valuePriorityContext(rates, trits, ctx);
  const priority = clampNumber(
    0.5 + (value.score * 0.28) + (((trits.novelty + 1) / 2) * 0.22),
    0.35,
    0.98,
    0.82
  );
  const candidate = normalizeCandidate({
    id: stableId(seed, 'wfc', 16),
    name: cleanText(src.name || `Creative ${proposalType}`, 120),
    status: 'draft',
    source: 'orchestron_candidate_generator',
    strategy_id: ctx.strategy_id,
    objective_id: null,
    objective_primary: cleanText(src.objective || ctx.objective_primary, 240),
    trigger: {
      proposal_type: proposalType,
      min_occurrences: clampInt(src.min_occurrences, 1, 10000, 2),
      intent_signature: ctx.intent.signature
    },
    intent: ctx.intent,
    parent_workflow_id: null,
    fractal_depth: 0,
    mutation: mutationKind !== 'none'
      ? {
        kind: mutationKind,
        parent_workflow_id: null,
        rationale: 'creative llm proposal'
      }
      : null,
    tradeoffs: normalizeTradeoffs(ctx.intent.constraints),
    risk_policy: {
      max_risk_per_action: clampInt(ctx.risk_policy && ctx.risk_policy.max_risk_per_action, 1, 100, 35),
      allowed_risks: [normalizeToken(src.risk || 'low', 20) || 'low']
    },
    steps,
    metadata: {
      generation_kind: 'creative_llm',
      priority: Number(priority.toFixed(4)),
      attempts: 0,
      shipped_rate: Number(rates.shipped_rate.toFixed(4)),
      failure_rate: Number(rates.failure_rate.toFixed(4)),
      no_change_rate: Number(rates.no_change_rate.toFixed(4)),
      intent_trit_alignment: Number(trits.alignment || 0),
      value_currency: value.value_currency || null,
      value_priority_score: Number(value.score || 0.5)
    },
    generated_at: nowIso()
  }, idx, {
    depth: 0,
    maxDepth: clampInt(ctx.fractal && ctx.fractal.max_depth, 1, 6, 3)
  });

  const childrenRaw = Array.isArray(src.children) ? src.children : [];
  if (candidate && childrenRaw.length) {
    const childRows = childrenRaw
      .map((child, i) => ({
        name: cleanText(child && child.name || `Creative child ${i + 1}`, 120),
        proposal_type: normalizeToken(child && child.proposal_type || `${proposalType}.child`, 80) || `${proposalType}.child`,
        objective: cleanText(child && child.objective || ctx.objective_primary, 220)
      }));
    const synthetic = {
      proposal_type: proposalType,
      attempts: 4,
      shipped: 1,
      no_change: 3,
      holds: 0,
      stops: 0
    };
    const spawned = spawnFractalChildren(candidate, { ...synthetic, ...patternRates(synthetic) }, ctx, 'creative');
    if (spawned.length) {
      for (let i = 0; i < Math.min(spawned.length, childRows.length); i += 1) {
        spawned[i].name = cleanText(`${candidate.name} :: ${childRows[i].name}`, 120);
        spawned[i].trigger.proposal_type = childRows[i].proposal_type;
        spawned[i].objective_primary = childRows[i].objective;
      }
    }
    candidate.children = spawned;
    candidate.metadata = {
      ...(candidate.metadata || {}),
      fractal_children_count: spawned.length
    };
  }

  return candidate;
}

function generateCreativeCandidates(ctx, existingIds = new Set()) {
  const policy = normalizeCreativePolicy(ctx && ctx.creative_llm);
  if (policy.enabled !== true) return [];
  const slots = Math.max(0, Number(ctx.max_candidates || 0) - Number(existingIds.size || 0));
  if (slots <= 0) return [];
  const t = tritContext(ctx && ctx.intent);
  if (t.novelty < policy.min_novelty_trit) return [];
  const prompt = buildCreativePrompt(ctx, Math.min(slots, policy.max_candidates));
  const llm = runLocalOllamaPrompt({
    model: policy.model,
    prompt,
    timeoutMs: policy.timeout_ms,
    phase: 'orchestron_creative',
    source: 'orchestron_candidate_generator',
    source_fingerprint: String(ctx && ctx.intent && ctx.intent.signature || ''),
    use_cache: true,
    cache_ttl_ms: policy.cache_ttl_ms,
    allowFlagFallback: true
  });
  if (!llm || llm.ok !== true) return [];
  const parsed = extractJsonBlock(llm.stdout);
  const candidatesRaw = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.candidates) ? parsed.candidates : []);
  if (!candidatesRaw.length) return [];
  const out = [];
  for (let i = 0; i < candidatesRaw.length; i += 1) {
    if (out.length >= policy.max_candidates) break;
    const candidate = creativeCandidateFromRow(candidatesRaw[i], i, ctx);
    if (!candidate || !candidate.id || existingIds.has(candidate.id)) continue;
    existingIds.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function candidatePriority(candidate) {
  const src = candidate && typeof candidate === 'object' ? candidate : {};
  const meta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
  const shippedRate = clampNumber(meta.shipped_rate, 0, 1, 0);
  const failureRate = clampNumber(meta.failure_rate, 0, 1, 1);
  const tritAlignment = clampNumber(meta.intent_trit_alignment, -1, 1, 0);
  const valuePriorityScore = clampNumber(meta.value_priority_score, 0, 1, 0.5);
  const childrenCount = Array.isArray(src.children) ? src.children.length : 0;
  const priority = clampNumber(meta.priority, 0, 1, 0.5);
  return Number((
    (priority * 0.45)
    + (shippedRate * 0.16)
    + ((1 - failureRate) * 0.13)
    + (((tritAlignment + 1) / 2) * 0.12)
    + (valuePriorityScore * 0.12)
    + (Math.min(childrenCount, 4) * 0.015)
  ).toFixed(6));
}

function patternRowForProposalType(rows, proposalType) {
  const normalized = normalizeToken(proposalType || 'unknown', 80) || 'unknown';
  for (const row of Array.isArray(rows) ? rows : []) {
    const candidateType = normalizeToken(row && row.proposal_type || 'unknown', 80) || 'unknown';
    if (candidateType === normalized) return row;
  }
  return null;
}

function runtimeEvolutionCandidates(ctx, existingIds = new Set()) {
  const policy = normalizeRuntimeEvolutionPolicy(ctx && ctx.runtime_evolution);
  if (policy.enabled !== true || policy.max_candidates <= 0) return [];
  const activeRegistry = (Array.isArray(ctx && ctx.registry_workflows) ? ctx.registry_workflows : [])
    .filter((row) => String(row && row.status || '').toLowerCase() === 'active');
  const out = [];
  for (let i = 0; i < activeRegistry.length; i += 1) {
    if (out.length >= policy.max_candidates) break;
    const wf = activeRegistry[i];
    const proposalType = normalizeToken(wf && wf.trigger && wf.trigger.proposal_type || 'unknown', 80) || 'unknown';
    const pattern = patternRowForProposalType(ctx && ctx.pattern_rows, proposalType);
    if (!pattern) continue;
    const rates = patternRates(pattern);
    const pressure = {
      failure_pressure: rates.failure_rate,
      no_change_pressure: rates.no_change_rate
    };
    const isFailurePressure = rates.failure_rate >= policy.failure_pressure_min;
    const isNoChangePressure = rates.no_change_rate >= policy.no_change_pressure_min;
    if (!isFailurePressure && !isNoChangePressure) continue;

    const mutationKinds = chooseMutationKinds(
      {
        ...wf,
        metrics: {
          ...(wf && wf.metrics && typeof wf.metrics === 'object' ? wf.metrics : {}),
          failure_rate: rates.failure_rate,
          no_change_rate: rates.no_change_rate
        }
      },
      ctx,
      pressure
    );
    if (!mutationKinds.length) continue;
    const kind = mutationKinds[0];
    const candidate = workflowToMutationCandidate(
      wf,
      kind,
      out.length,
      ctx,
      {
        generation_kind: 'runtime_evolution',
        pressure
      }
    );
    if (!candidate || !candidate.id || existingIds.has(candidate.id)) continue;
    existingIds.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function generateCandidates(input) {
  const ctx = input && typeof input === 'object' ? input : {};
  const maxCandidates = clampInt(ctx.max_candidates, 1, 24, 8);
  const minCandidates = clampInt(ctx.min_candidates, 1, maxCandidates, 3);
  const rows = Array.isArray(ctx.pattern_rows) ? ctx.pattern_rows.slice() : [];
  const registry = Array.isArray(ctx.registry_workflows) ? ctx.registry_workflows.slice() : [];

  const sortedPatterns = rows
    .filter((row) => Number(row && row.attempts || 0) > 0)
    .sort((a, b) => {
      const aRates = patternRates(a);
      const bRates = patternRates(b);
      const aScore = (aRates.shipped_rate * 0.55) + ((1 - aRates.failure_rate) * 0.45);
      const bScore = (bRates.shipped_rate * 0.55) + ((1 - bRates.failure_rate) * 0.45);
      if (bScore !== aScore) return bScore - aScore;
      return bRates.attempts - aRates.attempts;
    });

  const candidates = [];
  const existingIds = new Set();
  const patternBudget = Math.max(1, Math.min(maxCandidates, 4));
  for (let i = 0; i < sortedPatterns.length && candidates.length < patternBudget; i += 1) {
    const candidate = patternToCandidate(sortedPatterns[i], i, ctx);
    if (!candidate || !candidate.id || existingIds.has(candidate.id)) continue;
    existingIds.add(candidate.id);
    candidates.push(candidate);
  }

  const activeRegistry = registry
    .filter((row) => String(row && row.status || '').toLowerCase() === 'active')
    .slice(0, 8);
  for (const row of activeRegistry) {
    const proposalType = normalizeToken(row && row.trigger && row.trigger.proposal_type || 'unknown', 80) || 'unknown';
    const pattern = patternRowForProposalType(sortedPatterns, proposalType);
    const rates = pattern ? patternRates(pattern) : { failure_rate: Number(row && row.metrics && row.metrics.failure_rate || 0), no_change_rate: 0 };
    const mutationKinds = chooseMutationKinds(row, ctx, {
      failure_pressure: rates.failure_rate,
      no_change_pressure: rates.no_change_rate
    });
    for (const mutationKind of mutationKinds) {
      if (candidates.length >= maxCandidates) break;
      const candidate = workflowToMutationCandidate(row, mutationKind, candidates.length, ctx);
      if (!candidate || !candidate.id || existingIds.has(candidate.id)) continue;
      existingIds.add(candidate.id);
      candidates.push(candidate);
    }
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length < maxCandidates) {
    for (const candidate of runtimeEvolutionCandidates(ctx, existingIds)) {
      if (candidates.length >= maxCandidates) break;
      candidates.push(candidate);
    }
  }

  if (candidates.length < maxCandidates) {
    for (const candidate of generateCreativeCandidates({
      ...ctx,
      max_candidates: maxCandidates
    }, existingIds)) {
      if (candidates.length >= maxCandidates) break;
      candidates.push(candidate);
    }
  }

  if (candidates.length < minCandidates) {
    const fillerRows = sortedPatterns.length ? sortedPatterns : [{ proposal_type: 'unknown', attempts: 1, shipped: 0, no_change: 1, holds: 0, stops: 0 }];
    let fillerIdx = 0;
    while (candidates.length < minCandidates && candidates.length < maxCandidates) {
      const row = fillerRows[fillerIdx % fillerRows.length];
      const candidate = patternToCandidate(row, candidates.length, ctx);
      fillerIdx += 1;
      if (!candidate || !candidate.id) continue;
      if (existingIds.has(candidate.id)) continue;
      existingIds.add(candidate.id);
      candidates.push(candidate);
    }
  }

  const dedupe = new Map();
  for (const row of candidates) {
    if (!row || !row.id) continue;
    if (!dedupe.has(row.id)) {
      dedupe.set(row.id, row);
      continue;
    }
    const prev = dedupe.get(row.id);
    if (candidatePriority(row) >= candidatePriority(prev)) dedupe.set(row.id, row);
  }

  return Array.from(dedupe.values())
    .sort((a, b) => candidatePriority(b) - candidatePriority(a))
    .slice(0, maxCandidates);
}

module.exports = {
  defaultStepsForProposalType,
  mutateSteps,
  chooseMutationKinds,
  runtimeEvolutionCandidates,
  normalizeCreativePolicy,
  generateCreativeCandidates,
  generateCandidates
};

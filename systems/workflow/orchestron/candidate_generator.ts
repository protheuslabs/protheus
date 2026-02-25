#!/usr/bin/env node
'use strict';
export {};

const {
  stableId,
  cleanText,
  normalizeToken,
  clampInt,
  normalizeCandidate
} = require('./contracts');

function nowIso() {
  return new Date().toISOString();
}

function defaultStepsForProposalType(proposalType) {
  const p = String(proposalType || '').trim().toLowerCase();
  if (p.includes('collector') || p.includes('external')) {
    return [
      { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=<eye_id>', purpose: 'collect external signal', timeout_ms: 180000, retries: 1 },
      { id: 'ingest', type: 'command', command: 'node habits/scripts/sensory_queue.js ingest <date>', purpose: 'normalize and queue proposals', timeout_ms: 120000, retries: 1 },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce execution safety gates', timeout_ms: 120000, retries: 0 },
      { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record verifiable outcome', timeout_ms: 30000, retries: 0 }
    ];
  }
  if (p.includes('actuation') || p.includes('publish')) {
    return [
      { id: 'bridge', type: 'command', command: 'node systems/actuation/bridge_from_proposals.js run <date>', purpose: 'proposal to actuation contract', timeout_ms: 180000, retries: 1 },
      { id: 'execute', type: 'command', command: 'node systems/actuation/actuation_executor.js run --kind=<adapter> --dry-run', purpose: 'execute safely via adapter', timeout_ms: 240000, retries: 1 },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'postcondition and rollback checks', timeout_ms: 120000, retries: 0 },
      { id: 'receipt', type: 'receipt', command: 'state/actuation/receipts/<date>.jsonl', purpose: 'record receipt evidence', timeout_ms: 30000, retries: 0 }
    ];
  }
  return [
    { id: 'enrich', type: 'command', command: 'node systems/autonomy/proposal_enricher.js run <date>', purpose: 'normalize proposal shape', timeout_ms: 120000, retries: 1 },
    { id: 'rank', type: 'command', command: 'node systems/autonomy/autonomy_controller.js run <date>', purpose: 'rank and execute/preview', timeout_ms: 180000, retries: 1 },
    { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce safety and evidence checks', timeout_ms: 120000, retries: 0 },
    { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record final receipt evidence', timeout_ms: 30000, retries: 0 }
  ];
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
  return t;
}

function patternToCandidate(row, idx, ctx) {
  const proposalType = normalizeToken(row && row.proposal_type || 'unknown', 80) || 'unknown';
  const attempts = Number(row && row.attempts || 0);
  const shipped = Number(row && row.shipped || 0);
  const holds = Number(row && row.holds || 0);
  const stops = Number(row && row.stops || 0);
  const noChange = Number(row && row.no_change || 0);
  const shippedRate = attempts > 0 ? shipped / attempts : 0;
  const failureRate = attempts > 0 ? (holds + stops + noChange) / attempts : 1;
  const seed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|${proposalType}|pattern|${idx}`;

  return normalizeCandidate({
    id: stableId(seed, 'wfc', 16),
    name: `Adaptive ${proposalType} workflow`,
    status: 'draft',
    source: 'orchestron_candidate_generator',
    strategy_id: ctx.strategy_id,
    objective_id: row && row.recent_objective_id ? String(row.recent_objective_id) : null,
    objective_primary: ctx.objective_primary,
    trigger: {
      proposal_type: proposalType,
      min_occurrences: Math.max(2, Math.floor(Math.min(12, attempts / 2))),
      intent_signature: ctx.intent.signature
    },
    intent: ctx.intent,
    mutation: null,
    tradeoffs: ctx.intent.constraints,
    risk_policy: ctx.risk_policy,
    steps: defaultStepsForProposalType(proposalType),
    metadata: {
      generation_kind: 'pattern',
      attempts,
      shipped_rate: Number(shippedRate.toFixed(4)),
      failure_rate: Number(failureRate.toFixed(4))
    },
    generated_at: nowIso()
  }, idx);
}

function workflowToMutationCandidate(workflow, mutationKind, idx, ctx) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const proposalType = normalizeToken(wf.trigger && wf.trigger.proposal_type || 'unknown', 80) || 'unknown';
  const parentId = String(wf.id || '').trim();
  const seed = `${ctx.date}|${ctx.strategy_id}|${ctx.intent.id}|${parentId}|${mutationKind}|${idx}`;
  const baseSteps = Array.isArray(wf.steps) ? wf.steps : defaultStepsForProposalType(proposalType);
  const steps = mutateSteps(baseSteps, mutationKind);
  const mutation = {
    kind: mutationKind,
    parent_workflow_id: parentId,
    rationale: mutationKind === 'rollback_path'
      ? 'add deterministic rollback path for failed verifications'
      : (mutationKind === 'guard_hardening'
        ? 'insert preflight contract guard before receipt'
        : 'tune retries/timeouts for transient instability')
  };
  const metrics = wf.metrics && typeof wf.metrics === 'object' ? wf.metrics : {};
  return normalizeCandidate({
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
    mutation,
    tradeoffs: tradeoffForMutation(ctx.intent.constraints, mutationKind),
    risk_policy: wf.risk_policy || ctx.risk_policy,
    steps,
    metadata: {
      generation_kind: 'mutation',
      attempts: Number(metrics.attempts || 0),
      shipped_rate: Number(metrics.shipped_rate || 0),
      failure_rate: Number(metrics.failure_rate || 0)
    },
    generated_at: nowIso()
  }, idx);
}

function chooseMutationKinds(workflow) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const out = [];
  const hasRollback = hasStep(steps, (row) => String(row.id || '').toLowerCase().includes('rollback'));
  const hasPreflight = hasStep(steps, (row) => String(row.id || '').toLowerCase() === 'preflight');
  if (!hasPreflight) out.push('guard_hardening');
  if (!hasRollback) out.push('rollback_path');
  out.push('retry_tuning');
  return out.slice(0, 2);
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
      const aAttempts = Number(a && a.attempts || 0);
      const bAttempts = Number(b && b.attempts || 0);
      const aRate = aAttempts > 0 ? Number(a.shipped || 0) / aAttempts : 0;
      const bRate = bAttempts > 0 ? Number(b.shipped || 0) / bAttempts : 0;
      if (bRate !== aRate) return bRate - aRate;
      return bAttempts - aAttempts;
    });

  const candidates = [];
  const patternBudget = Math.max(1, Math.min(maxCandidates, 4));
  for (let i = 0; i < sortedPatterns.length && candidates.length < patternBudget; i += 1) {
    candidates.push(patternToCandidate(sortedPatterns[i], i, ctx));
  }

  const activeRegistry = registry
    .filter((row) => String(row && row.status || '').toLowerCase() === 'active')
    .slice(0, 6);
  for (const row of activeRegistry) {
    const mutationKinds = chooseMutationKinds(row);
    for (const mutationKind of mutationKinds) {
      if (candidates.length >= maxCandidates) break;
      candidates.push(workflowToMutationCandidate(row, mutationKind, candidates.length, ctx));
    }
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length < minCandidates) {
    const fillerRows = sortedPatterns.length ? sortedPatterns : [{ proposal_type: 'unknown', attempts: 1, shipped: 0, no_change: 1, holds: 0, stops: 0 }];
    let fillerIdx = 0;
    while (candidates.length < minCandidates && candidates.length < maxCandidates) {
      const row = fillerRows[fillerIdx % fillerRows.length];
      candidates.push(patternToCandidate(row, candidates.length, ctx));
      fillerIdx += 1;
    }
  }

  const dedupe = new Map();
  for (const row of candidates) {
    if (!row || !row.id) continue;
    if (!dedupe.has(row.id)) dedupe.set(row.id, row);
  }

  return Array.from(dedupe.values()).slice(0, maxCandidates);
}

module.exports = {
  defaultStepsForProposalType,
  mutateSteps,
  generateCandidates
};

#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toNumber(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cloneSteps(steps: AnyObj[]) {
  return Array.isArray(steps)
    ? steps.map((row) => ({ ...(row || {}) }))
    : [];
}

function hasStepId(steps: AnyObj[], stepId: string) {
  return Array.isArray(steps) && steps.some((row) => String(row && row.id || '') === String(stepId || ''));
}

function normalizeStep(row: AnyObj, index: number) {
  const src = row && typeof row === 'object' ? row : {};
  const stepId = normalizeToken(src.id || `step_${index + 1}`, 120) || `step_${index + 1}`;
  return {
    ...src,
    id: stepId,
    type: normalizeToken(src.type || 'command', 40) || 'command',
    command: cleanText(src.command || '', 1200),
    retries: Math.max(0, Math.floor(toNumber(src.retries, 0))),
    timeout_ms: Math.max(100, Math.floor(toNumber(src.timeout_ms, 30000)))
  };
}

function insertBeforeReceipt(steps: AnyObj[], newStep: AnyObj) {
  const out = cloneSteps(steps);
  const receiptIdx = out.findIndex((row) => String(row && row.type || '').toLowerCase() === 'receipt');
  if (receiptIdx < 0) out.push(newStep);
  else out.splice(receiptIdx, 0, newStep);
  return out;
}

function candidateMutationOrder(workflow: AnyObj, step: AnyObj, policy: AnyObj, mutationSummary: AnyObj) {
  const allow = policy && policy.allow && typeof policy.allow === 'object' ? policy.allow : {};
  const order: string[] = [];
  const preferred = normalizeToken(workflow && workflow.mutation && workflow.mutation.kind || '', 60);
  const pushKind = (kind: string) => {
    if (allow[kind] !== true) return;
    if (!order.includes(kind)) order.push(kind);
  };
  if (preferred) pushKind(preferred);
  if (String(step && step.type || '').toLowerCase() !== 'receipt') pushKind('retry_tuning');
  pushKind('guard_hardening');
  pushKind('rollback_path');
  const attempts = mutationSummary && mutationSummary.by_kind && typeof mutationSummary.by_kind === 'object'
    ? mutationSummary.by_kind
    : {};
  const cap = Math.max(1, Math.floor(toNumber(policy && policy.max_attempts_per_kind, 3)));
  return order.filter((kind) => Number(attempts[kind] || 0) < cap);
}

function applyMutationKind(kind: string, steps: AnyObj[], stepIndex: number, policy: AnyObj) {
  const list = cloneSteps(steps);
  if (!list.length) return { ok: false, changed: false, reason: 'steps_empty' };
  const safeIndex = Math.max(0, Math.min(list.length - 1, Number(stepIndex || 0)));
  const target = list[safeIndex] || null;

  if (kind === 'retry_tuning') {
    if (!target || String(target.type || '').toLowerCase() === 'receipt') {
      return { ok: false, changed: false, reason: 'retry_tuning_ineligible_step' };
    }
    const increment = Math.max(0, Number(policy && policy.max_retry_increment || 0));
    if (increment <= 0) return { ok: false, changed: false, reason: 'retry_increment_disabled' };
    const maxTotal = Math.max(0, Number(policy && policy.max_total_retry_per_step || 0));
    const currentRetries = Math.max(0, Number(target.retries || 0));
    if (currentRetries >= maxTotal) return { ok: false, changed: false, reason: 'retry_cap_reached' };
    target.retries = Math.min(maxTotal, currentRetries + increment);
    list[safeIndex] = normalizeStep(target, safeIndex);
    return {
      ok: true,
      changed: true,
      steps: list,
      retry_index: safeIndex,
      detail: `step=${target.id} retries ${currentRetries}->${target.retries}`
    };
  }

  if (kind === 'guard_hardening') {
    if (hasStepId(list, 'preflight_runtime_guard')) {
      return { ok: false, changed: false, reason: 'preflight_guard_already_present' };
    }
    const guardStep = normalizeStep({
      id: 'preflight_runtime_guard',
      type: 'gate',
      command: 'node systems/autonomy/strategy_execute_guard.js run <date>',
      purpose: 'runtime mutation preflight guard',
      timeout_ms: 120000,
      retries: 0
    }, 0);
    list.splice(safeIndex, 0, guardStep);
    return {
      ok: true,
      changed: true,
      steps: list,
      retry_index: safeIndex,
      detail: 'inserted preflight_runtime_guard'
    };
  }

  if (kind === 'rollback_path') {
    const hasRollback = list.some((row) => String(row && row.id || '').toLowerCase().includes('rollback'));
    if (hasRollback) {
      return { ok: false, changed: false, reason: 'rollback_step_already_present' };
    }
    let rollbackId = 'rollback_runtime';
    let suffix = 1;
    while (hasStepId(list, rollbackId)) {
      rollbackId = `rollback_runtime_${suffix}`;
      suffix += 1;
    }
    const rollbackStep = normalizeStep({
      id: rollbackId,
      type: 'command',
      command: 'node systems/autonomy/strategy_execute_guard.js rollback <date>',
      purpose: 'runtime mutation rollback path',
      timeout_ms: 120000,
      retries: 0
    }, list.length);
    return {
      ok: true,
      changed: true,
      steps: insertBeforeReceipt(list, rollbackStep),
      retry_index: safeIndex,
      detail: `inserted ${rollbackId}`
    };
  }

  return { ok: false, changed: false, reason: 'unknown_mutation_kind' };
}

function evaluateMutationGate(context: AnyObj, policy: AnyObj) {
  const reasons: string[] = [];
  const nowMs = Number.isFinite(Date.parse(String(context && context.now_ts || '')))
    ? Date.parse(String(context.now_ts))
    : Date.now();
  const vetoWindowSec = Math.max(0, Math.floor(toNumber(policy && policy.veto_window_sec, 0)));
  const lastFailureTs = Date.parse(String(context && context.last_failure_ts || ''));
  let vetoUntilTs = null;
  if (Number.isFinite(lastFailureTs) && vetoWindowSec > 0) {
    const until = new Date(lastFailureTs + (vetoWindowSec * 1000)).toISOString();
    vetoUntilTs = until;
    if (nowMs < Date.parse(until)) reasons.push('within_veto_window');
  }

  if (policy && policy.require_safety_attestation === true && context && context.safety_attested !== true) {
    reasons.push('missing_safety_attestation');
  }

  const impact = normalizeToken(context && context.objective_impact || 'medium', 40) || 'medium';
  const highImpact = new Set(
    (Array.isArray(policy && policy.high_impact_levels)
      ? policy.high_impact_levels
      : ['high', 'critical']).map((v: unknown) => normalizeToken(v, 40)).filter(Boolean)
  );
  if (highImpact.has(impact) && policy && policy.require_human_veto_for_high_impact === true) {
    if (context && context.human_veto_cleared !== true) {
      reasons.push('high_impact_requires_human_veto_clearance');
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    veto_until_ts: vetoUntilTs,
    objective_impact: impact
  };
}

module.exports = {
  candidateMutationOrder,
  applyMutationKind,
  evaluateMutationGate
};


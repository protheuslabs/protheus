#!/usr/bin/env node
'use strict';

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function normalizePressure(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'soft' || s === 'hard') return s;
  return 'none';
}

function computeEvidenceRunPlan(configuredRunsRaw, budgetPressureRaw, projectedPressureRaw) {
  const configuredRuns = clampInt(configuredRunsRaw, 0, 6, 2);
  const budgetPressure = normalizePressure(budgetPressureRaw);
  const projectedPressure = normalizePressure(projectedPressureRaw);
  const pressureThrottle = budgetPressure !== 'none' || projectedPressure !== 'none';
  const evidenceRuns = pressureThrottle
    ? Math.min(configuredRuns, 1)
    : configuredRuns;
  return {
    configured_runs: configuredRuns,
    budget_pressure: budgetPressure,
    projected_pressure: projectedPressure,
    pressure_throttle: pressureThrottle,
    evidence_runs: evidenceRuns
  };
}

module.exports = {
  computeEvidenceRunPlan
};


#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function evaluateLiveness(observations: AnyObj[] = [], policy: AnyObj = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const minRequired = clampInt(policy.min_liveness_modalities, 1, 32, 2);
  const liveRows = rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (row.replay_risk === true) return false;
    if (row.liveness_ok !== true) return false;
    return Number(row.confidence || 0) > 0;
  });
  const reasonCodes: string[] = [];
  if (rows.length === 0) reasonCodes.push('no_modalities_observed');
  if (liveRows.length < minRequired) reasonCodes.push('insufficient_live_modalities');
  if (rows.some((row) => row && row.replay_risk === true)) reasonCodes.push('replay_risk_detected');
  return {
    ok: true,
    min_required: minRequired,
    live_modalities: liveRows.length,
    total_modalities: rows.length,
    pass: liveRows.length >= minRequired && !reasonCodes.includes('replay_risk_detected'),
    reason_codes: reasonCodes
  };
}

module.exports = {
  evaluateLiveness
};


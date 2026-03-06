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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeTier(v: unknown) {
  const s = normalizeToken(v, 80);
  if (['clear', 'stasis', 'confirmed_malice'].includes(s)) return s;
  return 'clear';
}

function evaluateSentinel(verifier: AnyObj = {}, codexVerification: AnyObj = {}, policy: AnyObj = {}, prevState: AnyObj = {}) {
  const sentinelPolicy = policy && policy.sentinel && typeof policy.sentinel === 'object'
    ? policy.sentinel
    : {};
  const thresholds = sentinelPolicy.thresholds && typeof sentinelPolicy.thresholds === 'object'
    ? sentinelPolicy.thresholds
    : {};
  const stasisMismatchThreshold = clampInt(thresholds.stasis_mismatch_count, 1, 1000000, 1);
  const maliceMismatchThreshold = clampInt(thresholds.malice_mismatch_count, 1, 1000000, 8);
  const maliceScoreThreshold = clampNumber(thresholds.confirmed_malice_score, 0, 100, 3);
  const forcedMalice = sentinelPolicy.force_confirmed_malice === true;
  const verifierMismatchCount = Array.isArray(verifier && verifier.mismatches)
    ? verifier.mismatches.length
    : 0;
  const codexFailed = codexVerification && codexVerification.ok === false;
  const codexSigMismatch = Array.isArray(codexVerification && codexVerification.reason_codes)
    && codexVerification.reason_codes.includes('codex_signature_mismatch');

  let score = 0;
  if (verifierMismatchCount >= stasisMismatchThreshold) score += 1;
  if (verifierMismatchCount >= maliceMismatchThreshold) score += 1.4;
  if (codexFailed) score += 1.2;
  if (codexSigMismatch) score += 1.4;
  if (forcedMalice) score += 100;

  const priorTier = normalizeTier(prevState && prevState.current_tier || 'clear');
  if (priorTier === 'stasis' && verifierMismatchCount > 0) score += 0.3;
  if (priorTier === 'confirmed_malice') score += 0.6;

  const reasonCodes: string[] = [];
  if (verifierMismatchCount > 0) reasonCodes.push('sentinel_strand_mismatch');
  if (codexFailed) reasonCodes.push('sentinel_codex_verification_failed');
  if (codexSigMismatch) reasonCodes.push('sentinel_codex_signature_mismatch');
  if (forcedMalice) reasonCodes.push('sentinel_force_confirmed_malice');

  let tier = 'clear';
  if (score >= maliceScoreThreshold) tier = 'confirmed_malice';
  else if (verifierMismatchCount >= stasisMismatchThreshold || codexFailed) tier = 'stasis';

  if (!reasonCodes.length) reasonCodes.push('sentinel_clear');
  return {
    ok: true,
    tier,
    score: Number(score.toFixed(6)),
    mismatch_count: verifierMismatchCount,
    reason_codes: reasonCodes,
    prior_tier: priorTier
  };
}

module.exports = {
  evaluateSentinel
};

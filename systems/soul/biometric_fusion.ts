#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

type AnyObj = Record<string, any>;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function cleanText(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function fuseBiometricAttestation(input: AnyObj = {}) {
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const liveness = input.liveness && typeof input.liveness === 'object'
    ? input.liveness
    : {};
  const kThreshold = clampInt(policy.k_of_n_threshold, 1, 64, 2);
  const minConfidence = clampNumber(policy.min_confidence, 0, 1, 0.82);

  const weighted = observations.map((row) => {
    const weight = clampNumber(row && row.weight, 0, 1, 0);
    const confidence = clampNumber(row && row.confidence, 0, 1, 0);
    return {
      modality_id: normalizeToken(row && row.modality_id || '', 80) || 'unknown',
      weight,
      confidence,
      min_confidence: clampNumber(row && row.min_confidence, 0, 1, 0.7),
      liveness_ok: row && row.liveness_ok === true,
      replay_risk: row && row.replay_risk === true,
      commitment: cleanText(row && row.commitment || '', 256)
    };
  }).sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0));

  const matched = weighted.filter((row) => (
    row.liveness_ok === true
    && row.replay_risk !== true
    && row.confidence >= Number(row.min_confidence || 0.7)
  ));
  const totalWeight = weighted.reduce((sum, row) => sum + Number(row.weight || 0), 0);
  const confidenceScore = totalWeight > 0
    ? weighted.reduce((sum, row) => sum + Number(row.confidence || 0) * Number(row.weight || 0), 0) / totalWeight
    : 0;
  const reasonCodes: string[] = [];
  if (weighted.length === 0) reasonCodes.push('no_active_modalities');
  if (matched.length < kThreshold) reasonCodes.push('k_threshold_not_met');
  if (!(liveness && liveness.pass === true)) reasonCodes.push('liveness_not_met');
  if (confidenceScore < minConfidence) reasonCodes.push('confidence_below_threshold');

  const match = reasonCodes.length === 0;
  const commitmentId = `sp_${sha256Hex([
    ...matched.map((row) => row.commitment || '').filter(Boolean).sort(),
    String(confidenceScore.toFixed(6)),
    String(kThreshold),
    String(input.challenge_nonce || '')
  ].join('|')).slice(0, 24)}`;
  return {
    ok: true,
    checked: true,
    shadow_only: policy.shadow_only !== false,
    match,
    confidence: Number(confidenceScore.toFixed(6)),
    k_threshold: kThreshold,
    min_confidence: minConfidence,
    matched_modalities: matched.length,
    total_modalities: weighted.length,
    liveness_ok: liveness && liveness.pass === true,
    reason_codes: reasonCodes,
    commitment_id: commitmentId
  };
}

module.exports = {
  fuseBiometricAttestation
};


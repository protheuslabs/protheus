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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function decideMorphState(signals: AnyObj = {}, policy: AnyObj = {}, prevState: AnyObj = {}) {
  const consensusCfg = policy && policy.consensus && typeof policy.consensus === 'object'
    ? policy.consensus
    : {};
  const warCfg = policy && policy.war_mode && typeof policy.war_mode === 'object'
    ? policy.war_mode
    : {};
  const confidenceThreshold = clampNumber(warCfg.confidence_threshold, 0, 1, 0.95);
  const requireHelixTamper = consensusCfg.require_helix_tamper !== false;
  const requireSentinelAgreement = consensusCfg.require_sentinel_agreement !== false;
  const requireSoulMismatch = consensusCfg.require_soul_mismatch === true;
  const allowWar = warCfg.enabled !== false;

  const helixTamper = signals.helix_tamper === true;
  const sentinelAgreement = signals.sentinel_agreement === true;
  const soulMismatch = signals.soul_mismatch === true;
  const redConfidence = clampNumber(signals.red_confidence, 0, 1, 0);

  const reasons: string[] = [];
  if (helixTamper) reasons.push('helix_tamper_signal');
  if (sentinelAgreement) reasons.push('sentinel_consensus_signal');
  if (soulMismatch) reasons.push('soul_token_mismatch_signal');
  if (redConfidence >= confidenceThreshold) reasons.push('red_team_confidence_threshold_met');

  const consensusPass = (
    (!requireHelixTamper || helixTamper)
    && (!requireSentinelAgreement || sentinelAgreement)
    && (!requireSoulMismatch || soulMismatch)
    && redConfidence >= confidenceThreshold
  );

  let mode = 'peacetime';
  if (allowWar && consensusPass) mode = 'war';
  const priorMode = normalizeToken(prevState && prevState.mode || 'peacetime', 32) || 'peacetime';
  const transition = priorMode === mode ? 'steady' : `${priorMode}_to_${mode}`;
  if (mode === 'peacetime' && !reasons.length) reasons.push('consensus_not_met');

  return {
    ok: true,
    mode,
    prior_mode: priorMode,
    transition,
    consensus_pass: consensusPass,
    confidence_threshold: confidenceThreshold,
    red_confidence: redConfidence,
    reasons
  };
}

module.exports = {
  decideMorphState
};

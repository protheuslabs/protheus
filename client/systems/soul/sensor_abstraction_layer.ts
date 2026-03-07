#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function envKeyForModality(modalityId: string, suffix: string) {
  const key = normalizeToken(modalityId, 80).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `SOUL_SENSOR_${key}_${suffix}`;
}

function profileDefaults(profile: string) {
  const p = normalizeToken(profile || 'stable', 24) || 'stable';
  if (p === 'degraded') {
    return { confidence: 0.61, liveness_ok: true };
  }
  if (p === 'low_signal') {
    return { confidence: 0.52, liveness_ok: false };
  }
  return { confidence: 0.9, liveness_ok: true };
}

function collectSensorObservation(modality: AnyObj = {}, input: AnyObj = {}) {
  const modalityId = normalizeToken(modality.id || '', 80) || 'unknown';
  const challengeNonce = cleanText(input.challenge_nonce || '', 120) || 'no_nonce';
  const profile = normalizeToken(
    process.env[envKeyForModality(modalityId, 'PROFILE')]
      || modality.mock_profile
      || input.mock_profile
      || process.env.SOUL_SENSOR_PROFILE
      || 'stable',
    40
  ) || 'stable';
  const defaults = profileDefaults(profile);
  const confidenceOverride = process.env[envKeyForModality(modalityId, 'CONFIDENCE')];
  const confidence = clampNumber(
    confidenceOverride != null ? confidenceOverride : defaults.confidence,
    0,
    1,
    Number(modality.min_confidence || 0.7)
  );
  const liveOverride = process.env[envKeyForModality(modalityId, 'LIVE')];
  const livenessOk = toBool(
    liveOverride != null ? liveOverride : defaults.liveness_ok,
    defaults.liveness_ok
  );
  const replayFlag = toBool(process.env[envKeyForModality(modalityId, 'REPLAY')], false);
  const sampleTs = nowIso();
  const commitmentSeed = cleanText(
    process.env[envKeyForModality(modalityId, 'SEED')]
      || process.env.SOUL_SENSOR_SEED
      || `${modalityId}_seed`,
    220
  ) || `${modalityId}_seed`;
  const commitment = `zc_${sha256Hex([
    modalityId,
    challengeNonce,
    commitmentSeed,
    String(sampleTs).slice(0, 16),
    String(confidence.toFixed(6)),
    livenessOk ? 'live' : 'not_live'
  ].join('|'))}`;
  return {
    modality_id: modalityId,
    source: cleanText(modality.source || 'unknown', 120) || 'unknown',
    sample_ts: sampleTs,
    confidence: Number(confidence.toFixed(6)),
    liveness_ok: livenessOk === true,
    replay_risk: replayFlag === true,
    challenge_nonce_hash: sha256Hex(challengeNonce),
    commitment,
    raw_redacted: true,
    profile
  };
}

function collectSensorObservations(modalities: AnyObj[] = [], input: AnyObj = {}) {
  const rows = Array.isArray(modalities) ? modalities : [];
  const observations = [];
  for (const modality of rows) {
    if (!(modality && modality.enabled === true)) continue;
    observations.push(collectSensorObservation(modality, input));
  }
  return observations;
}

module.exports = {
  collectSensorObservation,
  collectSensorObservations
};


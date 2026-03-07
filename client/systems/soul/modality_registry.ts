#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

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

function defaultModalities() {
  return {
    voice: {
      enabled: true,
      weight: 0.34,
      min_confidence: 0.72,
      source: 'microphone',
      mock_profile: 'stable'
    },
    typing_rhythm: {
      enabled: true,
      weight: 0.24,
      min_confidence: 0.7,
      source: 'keyboard_dynamics',
      mock_profile: 'stable'
    },
    gait_motion: {
      enabled: true,
      weight: 0.18,
      min_confidence: 0.66,
      source: 'accelerometer',
      mock_profile: 'stable'
    },
    os_biometric_attestation: {
      enabled: true,
      weight: 0.24,
      min_confidence: 0.8,
      source: 'os_secure_enclave_attestation',
      mock_profile: 'stable'
    }
  };
}

function normalizeModality(id: string, row: AnyObj = {}) {
  const modalityId = normalizeToken(id, 80);
  if (!modalityId) return null;
  return {
    id: modalityId,
    enabled: toBool(row.enabled, true),
    weight: Number(clampNumber(row.weight, 0, 1, 0.1).toFixed(6)),
    min_confidence: Number(clampNumber(row.min_confidence, 0, 1, 0.7).toFixed(6)),
    source: cleanText(row.source || 'unknown', 120) || 'unknown',
    mock_profile: normalizeToken(row.mock_profile || 'stable', 40) || 'stable'
  };
}

function buildModalityRegistry(policy: AnyObj = {}) {
  const defaults = defaultModalities();
  const raw = policy && policy.modalities && typeof policy.modalities === 'object'
    ? policy.modalities
    : {};
  const ids = Array.from(new Set([
    ...Object.keys(defaults),
    ...Object.keys(raw)
  ]));
  const out: AnyObj[] = [];
  for (const id of ids) {
    const merged = {
      ...(defaults as AnyObj)[id],
      ...(raw as AnyObj)[id]
    };
    const normalized = normalizeModality(id, merged);
    if (normalized) out.push(normalized);
  }
  const totalWeight = out.reduce((sum, row) => sum + Number(row.weight || 0), 0);
  if (totalWeight > 0) {
    for (const row of out) {
      row.weight = Number((Number(row.weight || 0) / totalWeight).toFixed(6));
    }
  }
  return out.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

function listActiveModalities(policy: AnyObj = {}) {
  return buildModalityRegistry(policy).filter((row) => row.enabled === true);
}

module.exports = {
  defaultModalities,
  buildModalityRegistry,
  listActiveModalities
};


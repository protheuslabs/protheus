#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  cleanText,
  clampNumber,
  stableHash
} = require('./_shared');

function pickMaxScore(scores: Record<string, number>) {
  const entries = Object.entries(scores || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (entries.length < 1) return { behavior_class: 'unknown', confidence: 0 };
  const [topClass, topScore] = entries[0];
  const secondScore = entries[1] ? Number(entries[1][1]) : 0;
  const confidence = clampNumber((Number(topScore || 0) - secondScore) + 0.5, 0.05, 0.99, 0.5);
  return {
    behavior_class: cleanText(topClass, 80) || 'unknown',
    confidence: Number(confidence.toFixed(6))
  };
}

function computeClassScores(features: Record<string, any>) {
  const intervalMs = clampNumber(features.request_interval_ms, 10, 3_600_000, 60_000);
  const entropy = clampNumber(features.entropy_score, 0, 1, 0.5);
  const probeDensity = clampNumber(features.probe_density, 0, 1, 0.3);
  const signatureFailures = clampNumber(features.signature_failures, 0, 1000, 0);
  const escalationAttempts = clampNumber(features.escalation_attempts, 0, 1000, 0);
  const payloadVariance = clampNumber(features.payload_variance, 0, 1, 0.2);

  return {
    impatient: Number((Math.max(0, 1 - (intervalMs / 120_000)) * 0.55 + Math.min(1, escalationAttempts / 12) * 0.45).toFixed(6)),
    methodical: Number((Math.min(1, intervalMs / 180_000) * 0.4 + (1 - payloadVariance) * 0.35 + Math.min(1, probeDensity * 1.5) * 0.25).toFixed(6)),
    aggressive: Number((Math.min(1, escalationAttempts / 8) * 0.45 + Math.min(1, probeDensity * 1.3) * 0.35 + Math.min(1, entropy * 1.1) * 0.2).toFixed(6)),
    cautious: Number((Math.min(1, intervalMs / 240_000) * 0.5 + Math.max(0, 1 - probeDensity) * 0.3 + Math.max(0, 1 - entropy) * 0.2).toFixed(6)),
    overconfident: Number((Math.min(1, signatureFailures / 12) * 0.55 + Math.min(1, escalationAttempts / 10) * 0.25 + Math.min(1, payloadVariance * 1.5) * 0.2).toFixed(6)),
    script_kiddie: Number((Math.min(1, signatureFailures / 10) * 0.45 + Math.max(0, 1 - entropy) * 0.25 + Math.min(1, probeDensity * 1.5) * 0.3).toFixed(6)),
    nation_state: Number((Math.min(1, intervalMs / 300_000) * 0.2 + Math.min(1, entropy * 1.4) * 0.3 + Math.min(1, probeDensity * 1.2) * 0.3 + Math.max(0, 1 - signatureFailures / 8) * 0.2).toFixed(6))
  };
}

function synthesizeProfile(actorIdRaw: unknown, telemetry: Record<string, any> = {}, previous: Record<string, any> = null) {
  const actorId = cleanText(actorIdRaw || 'unknown_actor', 120) || 'unknown_actor';
  const features = {
    request_interval_ms: clampNumber(telemetry.request_interval_ms, 10, 3_600_000, 60_000),
    entropy_score: clampNumber(telemetry.entropy_score, 0, 1, 0.5),
    probe_density: clampNumber(telemetry.probe_density, 0, 1, 0.3),
    signature_failures: clampNumber(telemetry.signature_failures, 0, 1000, 0),
    escalation_attempts: clampNumber(telemetry.escalation_attempts, 0, 1000, 0),
    payload_variance: clampNumber(telemetry.payload_variance, 0, 1, 0.2),
    request_count: clampNumber(telemetry.request_count, 0, 1_000_000, 0)
  };
  const classScores = computeClassScores(features);
  const top = pickMaxScore(classScores);
  const previousClass = previous && previous.behavior_class ? cleanText(previous.behavior_class, 80) : null;
  const driftScore = previousClass && previousClass !== top.behavior_class ? 1 : 0;
  return {
    schema_id: 'psycheforge_profile',
    schema_version: '1.0',
    profile_id: `psy_${stableHash(`${actorId}|${JSON.stringify(features)}|${Date.now()}`, 18)}`,
    actor_id: actorId,
    generated_at: nowIso(),
    behavior_class: top.behavior_class,
    behavior_confidence: top.confidence,
    class_scores: classScores,
    drift: {
      previous_behavior_class: previousClass,
      changed: driftScore > 0,
      drift_score: driftScore
    },
    features
  };
}

module.exports = {
  synthesizeProfile
};

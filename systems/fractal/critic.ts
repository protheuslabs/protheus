#!/usr/bin/env node
'use strict';
export {};

/**
 * Fractal critic lane.
 *
 * This is intentionally deterministic and bounded: it transforms telemetry into
 * mutation-ready critique without directly applying any system changes.
 */

const {
  nowIso,
  cleanText,
  normalizeToken,
  clampNumber
} = require('../../lib/queued_backlog_runtime');

function pressurePenalty(pressure: string) {
  const p = normalizeToken(pressure || 'none', 24);
  if (p === 'critical') return 1;
  if (p === 'high') return 0.7;
  if (p === 'medium') return 0.35;
  if (p === 'low') return 0.1;
  return 0;
}

function proposeDomains(snapshot: any) {
  const domains = [];
  const drift = Number(snapshot && snapshot.drift && snapshot.drift.drift_rate);
  const pressure = normalizeToken(snapshot && snapshot.burn && snapshot.burn.pressure || 'none', 24);
  const authority = normalizeToken(snapshot && snapshot.stream && snapshot.stream.authority_source || '', 80);
  const mirrored = !!(snapshot && snapshot.stream && snapshot.stream.jetstream_mirrored === true);

  domains.push({
    id: 'habit_code',
    target_path: 'systems/adaptive/habits/habit_runtime_sync.ts',
    risk_tier: 2,
    summary: 'tighten habit runtime decisions around recent telemetry drift'
  });

  domains.push({
    id: 'memory_schema',
    target_path: 'systems/ops/schema_evolution_contract.ts',
    risk_tier: 2,
    summary: 'align memory schema evolution guardrails with latest mutation evidence'
  });

  domains.push({
    id: 'routing_policy',
    target_path: 'systems/routing/model_router.ts',
    risk_tier: 2,
    summary: 'tune model routing policy around observed stability and cost pressure'
  });

  if (Number.isFinite(drift) && drift >= 0.03) {
    domains.push({
      id: 'drift_control',
      target_path: 'systems/autonomy/drift_target_governor.ts',
      risk_tier: 2,
      summary: 'reduce autonomy drift rate by tightening acceptance thresholds'
    });
  }

  if (pressure === 'high' || pressure === 'critical') {
    domains.push({
      id: 'burn_guard',
      target_path: 'systems/ops/dynamic_burn_budget_oracle.ts',
      risk_tier: 2,
      summary: 'prioritize burn runway preservation under elevated pressure'
    });
  }

  if (authority !== 'stream_authority' || !mirrored) {
    domains.push({
      id: 'event_authority_hardening',
      target_path: 'systems/ops/event_sourced_control_plane.ts',
      risk_tier: 1,
      summary: 'enforce authoritative stream posture and jetstream mirror health'
    });
  }

  const dedup = new Map();
  for (const domain of domains) {
    const key = `${normalizeToken(domain.id, 80)}|${normalizeToken(domain.target_path, 200)}`;
    if (!dedup.has(key)) dedup.set(key, domain);
  }
  return Array.from(dedup.values());
}

function analyze(snapshot: any, options: any = {}) {
  const sourceCompleteness = Number(snapshot && snapshot.signals && snapshot.signals.source_completeness);
  const streamEvents = Number(snapshot && snapshot.stream && snapshot.stream.event_count_window || 0);
  const jetstreamMirrored = !!(snapshot && snapshot.stream && snapshot.stream.jetstream_mirrored === true);
  const burnPressure = String(snapshot && snapshot.burn && snapshot.burn.pressure || 'none');
  const driftRate = Number(snapshot && snapshot.drift && snapshot.drift.drift_rate);
  const autonomyScore = Number(snapshot && snapshot.autonomy_score);

  const completenessScore = Number.isFinite(sourceCompleteness)
    ? clampNumber(sourceCompleteness, 0, 1, 0)
    : 0;
  const streamScore = clampNumber(streamEvents / 80, 0, 1, 0);
  const jetstreamScore = jetstreamMirrored ? 1 : 0.45;
  const pressureScore = 1 - pressurePenalty(burnPressure);
  const driftScore = Number.isFinite(driftRate)
    ? 1 - clampNumber(driftRate / 0.08, 0, 1, 0)
    : 0.65;
  const autonomySignalScore = Number.isFinite(autonomyScore)
    ? clampNumber(autonomyScore, 0, 1, 0.5)
    : 0.5;

  const confidence = Number(clampNumber(
    (completenessScore * 0.22)
    + (streamScore * 0.18)
    + (jetstreamScore * 0.18)
    + (pressureScore * 0.18)
    + (driftScore * 0.12)
    + (autonomySignalScore * 0.12),
    0,
    1,
    0.5
  ).toFixed(6));

  const domains = proposeDomains(snapshot);
  const riskTierCeiling = confidence >= 0.997 ? 4 : 2;

  const findings = [];
  if (!jetstreamMirrored) findings.push('jetstream_mirror_not_confirmed');
  if (normalizeToken(burnPressure, 24) === 'critical') findings.push('burn_pressure_critical');
  if (Number.isFinite(driftRate) && driftRate > 0.04) findings.push('drift_rate_elevated');
  if (streamEvents < 2) findings.push('low_stream_activity');

  return {
    ok: true,
    schema_id: 'fractal_critic_result',
    schema_version: '1.0',
    ts: nowIso(),
    model: cleanText(options.model || 'grok-4-deep', 80) || 'grok-4-deep',
    confidence,
    risk_tier_ceiling: riskTierCeiling,
    signal_quality: {
      completeness: completenessScore,
      stream_score: streamScore,
      jetstream_score: jetstreamScore,
      pressure_score: pressureScore,
      drift_score: driftScore,
      autonomy_signal_score: autonomySignalScore
    },
    findings,
    domains,
    summary: cleanText(
      `confidence=${confidence.toFixed(3)} pressure=${normalizeToken(burnPressure, 24)} drift=${Number.isFinite(driftRate) ? driftRate.toFixed(4) : 'na'} domains=${domains.length}`,
      320
    )
  };
}

module.exports = {
  analyze,
  proposeDomains
};

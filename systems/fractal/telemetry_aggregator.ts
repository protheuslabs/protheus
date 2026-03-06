#!/usr/bin/env node
'use strict';
export {};

/**
 * Fractal telemetry aggregator.
 *
 * Collects bounded telemetry from existing primitives:
 * - event sourced control plane / JetStream mirror state
 * - burn budget oracle
 * - autonomy drift and receipt snapshots
 */

const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  clampNumber,
  clampInt,
  readJson,
  readJsonl,
  resolvePath,
  relPath
} = require('../../lib/queued_backlog_runtime');

function normalizePressure(raw: unknown) {
  const key = normalizeToken(raw || 'none', 24);
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  if (key === 'low') return 'low';
  return 'none';
}

function parseTsMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function countRecent(rows: any[], windowMs: number, predicate?: (row: any) => boolean) {
  const threshold = Date.now() - Math.max(1, Number(windowMs || 0));
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const tsMs = parseTsMs(row && row.ts);
    if (!tsMs || tsMs < threshold) continue;
    if (predicate && !predicate(row)) continue;
    count += 1;
  }
  return count;
}

function extractDriftRate(simulationLatest: any) {
  if (!simulationLatest || typeof simulationLatest !== 'object') return null;
  const candidates = [
    simulationLatest.drift_rate,
    simulationLatest.simulation && simulationLatest.simulation.drift_rate,
    simulationLatest.metrics && simulationLatest.metrics.drift_rate
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractAutonomySignal(receiptSummary: any) {
  if (!receiptSummary || typeof receiptSummary !== 'object') {
    return { success_rate: null, evidence_count: 0 };
  }
  const successRateRaw = receiptSummary.success_rate != null
    ? receiptSummary.success_rate
    : (receiptSummary.summary && receiptSummary.summary.success_rate);
  const evidenceCountRaw = receiptSummary.receipt_count != null
    ? receiptSummary.receipt_count
    : (receiptSummary.summary && receiptSummary.summary.receipt_count);
  const successRate = Number(successRateRaw);
  const evidenceCount = Number(evidenceCountRaw);
  return {
    success_rate: Number.isFinite(successRate) ? clampNumber(successRate, 0, 1, 0) : null,
    evidence_count: Number.isFinite(evidenceCount) ? Math.max(0, Math.floor(evidenceCount)) : 0
  };
}

function resolveTelemetryPaths(paths: any = {}) {
  const defaults = {
    burn_oracle_latest_path: 'state/ops/dynamic_burn_budget_oracle/latest.json',
    event_latest_path: 'state/ops/event_sourced_control_plane/latest.json',
    event_stream_path: 'state/ops/event_sourced_control_plane/stream_events.jsonl',
    authority_state_path: 'state/ops/event_sourced_control_plane/authority_state.json',
    jetstream_latest_path: 'state/ops/event_sourced_control_plane/jetstream_latest.json',
    receipt_summary_latest_path: 'state/autonomy/receipt_summary/latest.json',
    simulation_latest_path: 'state/autonomy/simulations/latest.json',
    fractal_state_path: 'systems/fractal/fractal_state.json'
  };
  return {
    burn_oracle_latest_path: resolvePath(paths.burn_oracle_latest_path || defaults.burn_oracle_latest_path, defaults.burn_oracle_latest_path),
    event_latest_path: resolvePath(paths.event_latest_path || defaults.event_latest_path, defaults.event_latest_path),
    event_stream_path: resolvePath(paths.event_stream_path || defaults.event_stream_path, defaults.event_stream_path),
    authority_state_path: resolvePath(paths.authority_state_path || defaults.authority_state_path, defaults.authority_state_path),
    jetstream_latest_path: resolvePath(paths.jetstream_latest_path || defaults.jetstream_latest_path, defaults.jetstream_latest_path),
    receipt_summary_latest_path: resolvePath(paths.receipt_summary_latest_path || defaults.receipt_summary_latest_path, defaults.receipt_summary_latest_path),
    simulation_latest_path: resolvePath(paths.simulation_latest_path || defaults.simulation_latest_path, defaults.simulation_latest_path),
    fractal_state_path: resolvePath(paths.fractal_state_path || defaults.fractal_state_path, defaults.fractal_state_path)
  };
}

function collect(options: any = {}) {
  const windowHours = clampInt(options.window_hours, 1, 7 * 24, 24);
  const windowMs = windowHours * 60 * 60 * 1000;
  const paths = resolveTelemetryPaths(options.paths || {});

  const burnLatest = readJson(paths.burn_oracle_latest_path, null);
  const eventLatest = readJson(paths.event_latest_path, null);
  const authorityState = readJson(paths.authority_state_path, null);
  const jetstreamLatest = readJson(paths.jetstream_latest_path, null);
  const streamRows = readJsonl(paths.event_stream_path).filter((row: any) => row && typeof row === 'object');
  const receiptSummary = readJson(paths.receipt_summary_latest_path, null);
  const simulationLatest = readJson(paths.simulation_latest_path, null);
  const fractalState = readJson(paths.fractal_state_path, null);

  const burnPressure = normalizePressure(
    burnLatest && (burnLatest.pressure || burnLatest.oracle_pressure || burnLatest.projection_pressure)
  );
  const projectedRunwayDays = Number(
    burnLatest && (
      burnLatest.projected_runway_days
      || (burnLatest.summary && burnLatest.summary.projected_runway_days)
    )
  );

  const streamEventsWindow = countRecent(streamRows, windowMs);
  const streamAppliesWindow = countRecent(streamRows, windowMs, (row) => {
    const evt = normalizeToken(
      row && row.event && row.event.event
      || row && row.event
      || '',
      80
    );
    return evt.includes('apply');
  });
  const streamMutationsWindow = countRecent(streamRows, windowMs, (row) => {
    const evt = normalizeToken(
      row && row.event && row.event.event
      || row && row.event
      || '',
      80
    );
    return evt.includes('mutation');
  });

  const driftRate = extractDriftRate(simulationLatest);
  const autonomySignal = extractAutonomySignal(receiptSummary);
  const jetstreamMirrored = !!(jetstreamLatest && jetstreamLatest.mirrored === true);
  const streamAuthority = normalizeToken(authorityState && authorityState.source || 'local_authority', 80)
    || 'local_authority';

  const availability = {
    burn_oracle: !!burnLatest,
    event_latest: !!eventLatest,
    event_stream: Array.isArray(streamRows) && streamRows.length > 0,
    authority_state: !!authorityState,
    jetstream_latest: !!jetstreamLatest,
    receipt_summary: !!receiptSummary,
    simulation_latest: !!simulationLatest
  };

  const availableCount = Object.values(availability).filter(Boolean).length;
  const completeness = Number((availableCount / Object.keys(availability).length).toFixed(4));

  let autonomyScore = 0.45;
  autonomyScore += Math.min(0.2, streamEventsWindow / 200);
  autonomyScore += jetstreamMirrored ? 0.14 : 0;
  autonomyScore += streamAuthority === 'stream_authority' ? 0.08 : 0;
  if (Number.isFinite(projectedRunwayDays)) {
    autonomyScore += clampNumber(projectedRunwayDays, 0, 10, 0) / 100;
  }
  if (burnPressure === 'critical') autonomyScore -= 0.28;
  else if (burnPressure === 'high') autonomyScore -= 0.18;
  else if (burnPressure === 'medium') autonomyScore -= 0.08;
  if (driftRate != null) autonomyScore -= clampNumber(driftRate, 0, 1, 0) * 0.3;
  if (autonomySignal.success_rate != null) autonomyScore += (autonomySignal.success_rate - 0.5) * 0.25;
  autonomyScore = clampNumber(Number(autonomyScore.toFixed(6)), 0, 1, 0.5);

  const previousStreamCount = Number(fractalState && fractalState.last_stream_event_count || 0);
  const previousApplyCount = Number(fractalState && fractalState.last_apply_event_count || 0);

  return {
    schema_id: 'fractal_telemetry_snapshot',
    schema_version: '1.0',
    ts: nowIso(),
    window_hours: windowHours,
    autonomy_score: autonomyScore,
    burn: {
      pressure: burnPressure,
      projected_runway_days: Number.isFinite(projectedRunwayDays)
        ? Number(projectedRunwayDays.toFixed(4))
        : null
    },
    stream: {
      authority_source: streamAuthority,
      jetstream_mirrored: jetstreamMirrored,
      event_count_window: streamEventsWindow,
      apply_count_window: streamAppliesWindow,
      mutation_count_window: streamMutationsWindow,
      event_count_delta: streamEventsWindow - previousStreamCount,
      apply_count_delta: streamAppliesWindow - previousApplyCount
    },
    drift: {
      drift_rate: driftRate != null ? Number(driftRate.toFixed(6)) : null
    },
    receipts: {
      success_rate: autonomySignal.success_rate,
      evidence_count: autonomySignal.evidence_count
    },
    signals: {
      source_completeness: completeness,
      source_availability: availability
    },
    sources: {
      burn_oracle_latest_path: relPath(paths.burn_oracle_latest_path),
      event_latest_path: relPath(paths.event_latest_path),
      event_stream_path: relPath(paths.event_stream_path),
      authority_state_path: relPath(paths.authority_state_path),
      jetstream_latest_path: relPath(paths.jetstream_latest_path),
      receipt_summary_latest_path: relPath(paths.receipt_summary_latest_path),
      simulation_latest_path: relPath(paths.simulation_latest_path)
    },
    notes: cleanText(options.notes || '', 240) || null
  };
}

module.exports = {
  collect,
  resolveTelemetryPaths
};

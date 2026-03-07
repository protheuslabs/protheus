#!/usr/bin/env node
'use strict';
export {};

const {
  loadEmbeddedObservabilityProfile,
  runChaosObservability
} = require('./index.js');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeProfile(input: AnyObj) {
  if (input && typeof input === 'object' && Object.keys(input).length > 0) {
    return input;
  }
  const loaded = loadEmbeddedObservabilityProfile({
    prefer_wasm: true,
    allow_cli_fallback: true
  });
  if (loaded && loaded.ok === true && loaded.payload && typeof loaded.payload === 'object') {
    return loaded.payload;
  }
  return {
    profile_id: 'observability_profile_unavailable',
    version: 0
  };
}

function runChaosObservabilityLegacy(requestRaw: AnyObj, _profileRaw?: AnyObj) {
  const result = runChaosObservability(requestRaw, {
    prefer_wasm: true,
    allow_cli_fallback: true
  });
  if (result && result.ok === true && result.payload && typeof result.payload === 'object') {
    return result.payload;
  }
  const scenarioId = cleanText(requestRaw && requestRaw.scenario_id, 160);
  return {
    profile_id: 'observability_profile_unavailable',
    scenario_id: scenarioId,
    hooks_fired: [],
    trace_report: {
      accepted_events: 0,
      dropped_events: 0,
      high_severity_events: 0,
      red_legion_channels_triggered: [],
      event_digest: '',
      drift_score_pct: 0
    },
    sovereignty: {
      score_pct: 0,
      fail_closed: true,
      status: 'fail_closed',
      reasons: ['observability_legacy_wrapper_rust_eval_failed'],
      integrity_component_pct: 0,
      continuity_component_pct: 0,
      reliability_component_pct: 0,
      chaos_penalty_pct: 0
    },
    telemetry_overhead_ms: 0,
    chaos_battery_pct_24h: 0,
    resilient: false
  };
}

function evaluateTraceWindow(profile: AnyObj, eventsIn: AnyObj[]) {
  const report = runChaosObservabilityLegacy({
    scenario_id: 'legacy_trace_window_probe',
    events: Array.isArray(eventsIn) ? eventsIn : [],
    cycles: 0,
    inject_fault_every: 0,
    enforce_fail_closed: false
  }, profile);
  return report && report.trace_report && typeof report.trace_report === 'object'
    ? report.trace_report
    : {
      accepted_events: 0,
      dropped_events: 0,
      high_severity_events: 0,
      red_legion_channels_triggered: [],
      event_digest: '',
      drift_score_pct: 0
    };
}

function computeSovereigntyIndex(
  profile: AnyObj,
  eventsIn: AnyObj[],
  _traceReport: AnyObj,
  injectFaultEvery: number,
  enforceFailClosed: boolean
) {
  const report = runChaosObservabilityLegacy({
    scenario_id: 'legacy_sovereignty_probe',
    events: Array.isArray(eventsIn) ? eventsIn : [],
    cycles: 0,
    inject_fault_every: Number.isFinite(Number(injectFaultEvery)) ? Number(injectFaultEvery) : 0,
    enforce_fail_closed: Boolean(enforceFailClosed)
  }, profile);
  return report && report.sovereignty && typeof report.sovereignty === 'object'
    ? report.sovereignty
    : {
      score_pct: 0,
      fail_closed: true,
      status: 'fail_closed',
      reasons: ['observability_legacy_wrapper_rust_eval_failed'],
      integrity_component_pct: 0,
      continuity_component_pct: 0,
      reliability_component_pct: 0,
      chaos_penalty_pct: 0
    };
}

module.exports = {
  normalizeProfile,
  evaluateTraceWindow,
  computeSovereigntyIndex,
  runChaosObservabilityLegacy
};

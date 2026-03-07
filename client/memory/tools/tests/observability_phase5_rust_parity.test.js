#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { loadEmbeddedObservabilityProfile, runChaosObservability } = require(path.join(ROOT, 'systems', 'observability', 'index.js'));
const { runChaosObservabilityLegacy } = require(path.join(ROOT, 'systems', 'observability', 'legacy_observability.js'));

function fail(msg) {
  console.error(`❌ observability_phase5_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer1/observability/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function round3(v) {
  return Math.round(Number(v || 0) * 1000) / 1000;
}

function normalizeReport(raw) {
  const trace = raw && raw.trace_report && typeof raw.trace_report === 'object' ? raw.trace_report : {};
  const sovereignty = raw && raw.sovereignty && typeof raw.sovereignty === 'object' ? raw.sovereignty : {};
  return {
    profile_id: String(raw && raw.profile_id || ''),
    scenario_id: String(raw && raw.scenario_id || ''),
    hooks_fired: Array.isArray(raw && raw.hooks_fired) ? raw.hooks_fired.slice() : [],
    trace_report: {
      accepted_events: Number(trace.accepted_events || 0),
      dropped_events: Number(trace.dropped_events || 0),
      high_severity_events: Number(trace.high_severity_events || 0),
      red_legion_channels_triggered: Array.isArray(trace.red_legion_channels_triggered) ? trace.red_legion_channels_triggered.slice() : [],
      event_digest: String(trace.event_digest || ''),
      drift_score_pct: round3(trace.drift_score_pct)
    },
    sovereignty: {
      score_pct: round3(sovereignty.score_pct),
      fail_closed: Boolean(sovereignty.fail_closed),
      status: String(sovereignty.status || ''),
      reasons: Array.isArray(sovereignty.reasons) ? sovereignty.reasons.slice() : [],
      integrity_component_pct: round3(sovereignty.integrity_component_pct),
      continuity_component_pct: round3(sovereignty.continuity_component_pct),
      reliability_component_pct: round3(sovereignty.reliability_component_pct),
      chaos_penalty_pct: round3(sovereignty.chaos_penalty_pct)
    },
    telemetry_overhead_ms: round3(raw && raw.telemetry_overhead_ms),
    chaos_battery_pct_24h: round3(raw && raw.chaos_battery_pct_24h),
    resilient: Boolean(raw && raw.resilient)
  };
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function buildCase(seed) {
  const rnd = seeded(seed + 31);
  const severities = ['low', 'medium', 'high', 'critical'];
  const tags = ['runtime.guardrails', 'lane.integrity', 'chaos.replay', 'sovereignty.index', 'drift', 'tamper'];
  const count = 2 + Math.floor(rnd() * 8);
  const events = [];
  let ts = 1000 + seed * 17;

  for (let i = 0; i < count; i += 1) {
    ts += 20 + Math.floor(rnd() * 350);
    const sev = severities[Math.floor(rnd() * severities.length)];
    const primaryTag = tags[Math.floor(rnd() * tags.length)];
    const secondaryTag = tags[Math.floor(rnd() * tags.length)];
    events.push({
      trace_id: `trace_${seed}_${i}`,
      ts_millis: ts,
      source: rnd() > 0.2 ? 'client/systems/observability' : 'client/systems/red_legion',
      operation: rnd() > 0.5 ? 'trace.capture' : 'chaos.replay',
      severity: sev,
      tags: [primaryTag, secondaryTag],
      payload_digest: `sha256:${seed}_${i}`,
      signed: rnd() > 0.18
    });
  }

  return {
    scenario_id: `scenario_${seed}`,
    events,
    cycles: 120000 + Math.floor(rnd() * 250000),
    inject_fault_every: Math.floor(rnd() * 500),
    enforce_fail_closed: rnd() > 0.25
  };
}

function main() {
  ensureReleaseBinary();

  const loaded = loadEmbeddedObservabilityProfile({ prefer_wasm: true, allow_cli_fallback: true });
  if (!loaded || loaded.ok !== true || !loaded.payload || typeof loaded.payload !== 'object') {
    fail(`unable to load profile from rust core: ${JSON.stringify(loaded || {})}`);
  }
  const profile = loaded.payload;

  const fixedCases = [
    {
      scenario_id: 'stable_fixed',
      events: [
        {
          trace_id: 'fixed_1',
          ts_millis: 1000,
          source: 'client/systems/observability',
          operation: 'trace.capture',
          severity: 'low',
          tags: ['runtime.guardrails'],
          payload_digest: 'sha256:fixed1',
          signed: true
        },
        {
          trace_id: 'fixed_2',
          ts_millis: 1080,
          source: 'client/systems/red_legion',
          operation: 'chaos.replay',
          severity: 'medium',
          tags: ['chaos.replay', 'drift'],
          payload_digest: 'sha256:fixed2',
          signed: true
        }
      ],
      cycles: 200000,
      inject_fault_every: 400,
      enforce_fail_closed: true
    },
    {
      scenario_id: 'tamper_fixed',
      events: [
        {
          trace_id: 'tamper_1',
          ts_millis: 2000,
          source: 'client/systems/observability',
          operation: 'trace.capture',
          severity: 'critical',
          tags: ['tamper'],
          payload_digest: 'sha256:tamper1',
          signed: false
        }
      ],
      cycles: 250000,
      inject_fault_every: 2,
      enforce_fail_closed: true
    }
  ];

  const allCases = fixedCases.concat(Array.from({ length: 45 }, (_, idx) => buildCase(idx)));

  for (const scenario of allCases) {
    const rustResult = runChaosObservability(scenario, { prefer_wasm: true, allow_cli_fallback: true });
    if (!rustResult || rustResult.ok !== true || !rustResult.payload || typeof rustResult.payload !== 'object') {
      fail(`rust run failed for ${scenario.scenario_id}: ${JSON.stringify(rustResult || {})}`);
    }

    const legacy = runChaosObservabilityLegacy(scenario, profile);
    const rustNorm = normalizeReport(rustResult.payload);
    const legacyNorm = normalizeReport(legacy);
    assert.deepStrictEqual(rustNorm, legacyNorm, `parity mismatch for ${scenario.scenario_id}`);
  }

  console.log('observability_phase5_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

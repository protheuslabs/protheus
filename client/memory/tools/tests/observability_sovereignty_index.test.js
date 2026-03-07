#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { loadEmbeddedObservabilityProfile, runChaosObservability } = require(path.join(ROOT, 'systems', 'observability', 'index.js'));

function fail(msg) {
  console.error(`❌ observability_sovereignty_index.test.js: ${msg}`);
  process.exit(1);
}

function mustRun(request) {
  const out = runChaosObservability(request, { prefer_wasm: true, allow_cli_fallback: true });
  if (!out || out.ok !== true || !out.payload || typeof out.payload !== 'object') {
    fail(`runChaosObservability failed: ${JSON.stringify(out || {})}`);
  }
  return out.payload;
}

function main() {
  const loaded = loadEmbeddedObservabilityProfile({ prefer_wasm: true, allow_cli_fallback: true });
  if (!loaded || loaded.ok !== true || !loaded.payload || typeof loaded.payload !== 'object') {
    fail(`loadEmbeddedObservabilityProfile failed: ${JSON.stringify(loaded || {})}`);
  }
  const threshold = Number(loaded.payload.sovereignty_scorer && loaded.payload.sovereignty_scorer.fail_closed_threshold_pct || 60);

  const healthy = mustRun({
    scenario_id: 'sovereignty_healthy',
    events: [
      {
        trace_id: 'h1',
        ts_millis: 1000,
        source: 'client/systems/observability',
        operation: 'trace.capture',
        severity: 'low',
        tags: ['runtime.guardrails'],
        payload_digest: 'sha256:h1',
        signed: true
      },
      {
        trace_id: 'h2',
        ts_millis: 1100,
        source: 'client/systems/security',
        operation: 'trace.capture',
        severity: 'low',
        tags: ['lane.integrity'],
        payload_digest: 'sha256:h2',
        signed: true
      }
    ],
    cycles: 160000,
    inject_fault_every: 500,
    enforce_fail_closed: true
  });
  assert.ok(Number(healthy.sovereignty.score_pct) >= threshold, 'healthy case should meet sovereignty threshold');
  assert.strictEqual(healthy.sovereignty.fail_closed, false);

  const degradedNoFail = mustRun({
    scenario_id: 'sovereignty_degraded_open',
    events: [
      {
        trace_id: 'd1',
        ts_millis: 1000,
        source: 'client/systems/observability',
        operation: 'trace.capture',
        severity: 'high',
        tags: ['drift'],
        payload_digest: 'sha256:d1',
        signed: false
      }
    ],
    cycles: 310000,
    inject_fault_every: 1,
    enforce_fail_closed: false
  });
  assert.ok(Number(degradedNoFail.sovereignty.score_pct) < threshold, 'degraded-open case should drop below threshold');
  assert.strictEqual(degradedNoFail.sovereignty.fail_closed, false, 'degraded-open should not fail-close');

  const tamperFailClosed = mustRun({
    scenario_id: 'sovereignty_tamper_closed',
    events: [
      {
        trace_id: 'c1',
        ts_millis: 1000,
        source: 'client/systems/observability',
        operation: 'trace.capture',
        severity: 'critical',
        tags: ['tamper', 'drift'],
        payload_digest: 'sha256:c1',
        signed: false
      }
    ],
    cycles: 280000,
    inject_fault_every: 2,
    enforce_fail_closed: true
  });
  assert.strictEqual(tamperFailClosed.sovereignty.fail_closed, true);
  assert.strictEqual(tamperFailClosed.sovereignty.status, 'fail_closed');

  console.log('observability_sovereignty_index.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

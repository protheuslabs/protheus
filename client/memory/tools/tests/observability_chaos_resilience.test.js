#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runChaosObservability } = require(path.join(ROOT, 'systems', 'observability', 'index.js'));

function fail(msg) {
  console.error(`❌ observability_chaos_resilience.test.js: ${msg}`);
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
  const stableReq = {
    scenario_id: 'chaos_stable',
    events: [
      {
        trace_id: 's1',
        ts_millis: 1000,
        source: 'client/systems/observability',
        operation: 'trace.capture',
        severity: 'low',
        tags: ['runtime.guardrails'],
        payload_digest: 'sha256:s1',
        signed: true
      },
      {
        trace_id: 's2',
        ts_millis: 1080,
        source: 'client/systems/red_legion',
        operation: 'chaos.replay',
        severity: 'medium',
        tags: ['chaos.replay'],
        payload_digest: 'sha256:s2',
        signed: true
      }
    ],
    cycles: 180000,
    inject_fault_every: 450,
    enforce_fail_closed: true
  };

  const stableA = mustRun(stableReq);
  const stableB = mustRun(stableReq);
  assert.deepStrictEqual(stableA, stableB, 'stable scenario should be deterministic');
  assert.strictEqual(stableA.resilient, true);
  assert.strictEqual(stableA.sovereignty.fail_closed, false);

  const stressedReq = {
    scenario_id: 'chaos_stressed',
    events: [
      {
        trace_id: 't1',
        ts_millis: 2000,
        source: 'client/systems/observability',
        operation: 'trace.capture',
        severity: 'critical',
        tags: ['tamper', 'drift'],
        payload_digest: 'sha256:t1',
        signed: false
      },
      {
        trace_id: 't2',
        ts_millis: 2050,
        source: 'client/systems/red_legion',
        operation: 'chaos.replay',
        severity: 'high',
        tags: ['chaos.replay', 'drift'],
        payload_digest: 'sha256:t2',
        signed: false
      }
    ],
    cycles: 360000,
    inject_fault_every: 1,
    enforce_fail_closed: true
  };

  const stressed = mustRun(stressedReq);
  assert.strictEqual(stressed.sovereignty.fail_closed, true);
  assert.strictEqual(stressed.resilient, false);
  assert.ok(Array.isArray(stressed.hooks_fired) && stressed.hooks_fired.length > 0);

  console.log('observability_chaos_resilience.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

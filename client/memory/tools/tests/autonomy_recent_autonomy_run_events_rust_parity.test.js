#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function tsMs(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getTime();
}

function jsRecentAutonomyRunEvents(events, cutoffMs, cap) {
  const out = [];
  for (const evt of events) {
    if (!evt || evt.type !== 'autonomy_run') continue;
    const ms = tsMs(evt.ts);
    if (ms == null || ms < cutoffMs) continue;
    out.push(evt);
    if (out.length >= cap) return out;
  }
  return out;
}

function rustRecentAutonomyRunEvents(events, cutoffMs, cap) {
  const rust = runBacklogAutoscalePrimitive(
    'recent_autonomy_run_events',
    {
      events,
      cutoff_ms: cutoffMs,
      cap
    },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return Array.isArray(rust.payload.payload && rust.payload.payload.events)
    ? rust.payload.payload.events
    : [];
}

function run() {
  const now = Date.now();
  const recent = new Date(now - 30 * 60 * 1000).toISOString();
  const old = new Date(now - 5 * 60 * 60 * 1000).toISOString();
  const cutoffMs = now - (2 * 60 * 60 * 1000);
  const cap = 50;

  const events = [
    { type: 'autonomy_run', ts: recent, result: 'executed' },
    { type: 'heartbeat', ts: recent, result: 'executed' },
    { type: 'autonomy_run', ts: old, result: 'executed' },
    { type: 'autonomy_run', ts: 'bad-ts', result: 'executed' },
    { type: 'autonomy_run', ts: recent, result: 'score_only_fallback_route_block' }
  ];

  const expected = jsRecentAutonomyRunEvents(events, cutoffMs, cap);
  const got = rustRecentAutonomyRunEvents(events, cutoffMs, cap);
  assert.deepStrictEqual(got, expected, 'recent autonomy run events mismatch');

  console.log('autonomy_recent_autonomy_run_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_recent_autonomy_run_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

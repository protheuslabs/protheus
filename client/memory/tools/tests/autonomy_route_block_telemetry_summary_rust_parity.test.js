#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsIsRouteExecutionSampleEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '').trim();
  if (!result) return false;
  if (result === 'score_only_fallback_route_block' || result === 'init_gate_blocked_route') return true;
  if (String(evt.execution_target || '').trim().toLowerCase() === 'route') return result === 'executed';
  if (result === 'executed' && evt.route_summary && typeof evt.route_summary === 'object') return true;
  return false;
}

function jsSummarize(events, hours) {
  const byCapability = {};
  for (const evt of events) {
    if (!jsIsRouteExecutionSampleEvent(evt)) continue;
    const key = String(evt.capability_key || '').trim().toLowerCase();
    if (!key) continue;
    if (!byCapability[key]) byCapability[key] = { attempts: 0, route_blocked: 0, route_block_rate: 0 };
    byCapability[key].attempts += 1;
    if (evt.result === 'score_only_fallback_route_block' || evt.result === 'init_gate_blocked_route') {
      byCapability[key].route_blocked += 1;
    }
  }
  for (const key of Object.keys(byCapability)) {
    const row = byCapability[key];
    row.route_block_rate = row.attempts > 0
      ? Number((Number(row.route_blocked || 0) / Number(row.attempts || 1)).toFixed(3))
      : 0;
  }
  return {
    window_hours: Math.max(1, Number(hours || 1)),
    sample_events: events.length,
    by_capability: byCapability
  };
}

function rustSummarize(events, hours) {
  const rust = runBacklogAutoscalePrimitive(
    'route_block_telemetry_summary',
    {
      events: events.map((evt) => ({
        event_type: evt && evt.type == null ? null : String(evt.type || ''),
        result: evt && evt.result == null ? null : String(evt.result || ''),
        execution_target: evt && evt.execution_target == null ? null : String(evt.execution_target || ''),
        route_summary_present: !!(evt && evt.route_summary && typeof evt.route_summary === 'object'),
        capability_key: evt && evt.capability_key == null ? null : String(evt.capability_key || '')
      })),
      window_hours: Number(hours || 1)
    },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  const payload = rust.payload.payload || {};
  const byCapability = {};
  for (const row of Array.isArray(payload.by_capability) ? payload.by_capability : []) {
    const key = String(row && row.key || '').trim().toLowerCase();
    if (!key) continue;
    byCapability[key] = {
      attempts: Number(row && row.attempts || 0),
      route_blocked: Number(row && row.route_blocked || 0),
      route_block_rate: Number(row && row.route_block_rate || 0)
    };
  }
  return {
    window_hours: Math.max(1, Number(payload.window_hours || 0)),
    sample_events: Number(payload.sample_events || 0),
    by_capability: byCapability
  };
}

function run() {
  const events = [
    { type: 'autonomy_run', result: 'executed', execution_target: 'route', capability_key: 'deploy' },
    { type: 'autonomy_run', result: 'score_only_fallback_route_block', execution_target: 'cell', capability_key: 'deploy' },
    { type: 'autonomy_run', result: 'init_gate_blocked_route', execution_target: 'cell', capability_key: 'lint' },
    { type: 'autonomy_run', result: 'executed', execution_target: 'cell', route_summary: { ok: true }, capability_key: 'lint' },
    { type: 'autonomy_run', result: 'no_change', execution_target: 'route', capability_key: 'deploy' },
    { type: 'heartbeat', result: 'executed', execution_target: 'route', capability_key: 'deploy' }
  ];

  const expected = jsSummarize(events, 6);
  const got = rustSummarize(events, 6);
  assert.deepStrictEqual(got, expected, 'route block telemetry summary mismatch');

  console.log('autonomy_route_block_telemetry_summary_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_route_block_telemetry_summary_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
  if (String(evt.execution_target || '').trim().toLowerCase() === 'route') {
    return result === 'executed';
  }
  if (result === 'executed' && evt.route_summary && typeof evt.route_summary === 'object') return true;
  return false;
}

function rustIsRouteExecutionSampleEvent(evt) {
  const rust = runBacklogAutoscalePrimitive(
    'route_execution_sample_event',
    {
      event_type: evt && evt.type == null ? null : String((evt && evt.type) || ''),
      result: evt && evt.result == null ? null : String((evt && evt.result) || ''),
      execution_target: evt && evt.execution_target == null ? null : String((evt && evt.execution_target) || ''),
      route_summary_present: !!(evt && evt.route_summary && typeof evt.route_summary === 'object')
    },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return rust.payload.payload && rust.payload.payload.is_sample_event === true;
}

function run() {
  const samples = [
    null,
    {},
    { type: 'autonomy_run', result: '', execution_target: 'route' },
    { type: 'autonomy_run', result: 'score_only_fallback_route_block', execution_target: 'cell' },
    { type: 'autonomy_run', result: 'init_gate_blocked_route', execution_target: 'cell' },
    { type: 'autonomy_run', result: 'executed', execution_target: 'route' },
    { type: 'autonomy_run', result: 'executed', execution_target: 'cell', route_summary: { note: 'ok' } },
    { type: 'autonomy_run', result: 'executed', execution_target: 'cell' },
    { type: 'heartbeat', result: 'executed', execution_target: 'route' }
  ];

  for (const evt of samples) {
    const expected = jsIsRouteExecutionSampleEvent(evt);
    const got = rustIsRouteExecutionSampleEvent(evt);
    assert.strictEqual(got, expected, `isRouteExecutionSampleEvent mismatch for evt=${JSON.stringify(evt)}`);
  }

  console.log('autonomy_route_execution_sample_event_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_route_execution_sample_event_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

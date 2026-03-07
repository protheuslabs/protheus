#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsRecentRunEvents(dayEvents) {
  const events = [];
  for (const bucket of dayEvents) {
    events.push(...bucket);
  }
  return events;
}

function rustRecentRunEvents(dayEvents) {
  const rust = runBacklogAutoscalePrimitive(
    'recent_run_events',
    { day_events: dayEvents },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return Array.isArray(rust.payload.payload && rust.payload.payload.events)
    ? rust.payload.payload.events
    : [];
}

function run() {
  const dayEvents = [
    [{ id: 'a' }, { id: 'b' }],
    [],
    [{ id: 'c' }]
  ];

  const expected = jsRecentRunEvents(dayEvents);
  const got = rustRecentRunEvents(dayEvents);
  assert.deepStrictEqual(got, expected, 'recentRunEvents mismatch');

  console.log('autonomy_recent_run_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_recent_run_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

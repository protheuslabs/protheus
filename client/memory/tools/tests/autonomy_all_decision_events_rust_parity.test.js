#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsAllDecisionEvents(dayEvents) {
  const out = [];
  for (const bucket of dayEvents) out.push(...bucket);
  return out;
}

function rustAllDecisionEvents(dayEvents) {
  const rust = runBacklogAutoscalePrimitive(
    'all_decision_events',
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
    [{ proposal_id: 'p1', type: 'decision' }],
    [],
    [{ proposal_id: 'p2', type: 'outcome' }]
  ];
  const expected = jsAllDecisionEvents(dayEvents);
  const got = rustAllDecisionEvents(dayEvents);
  assert.deepStrictEqual(got, expected, 'allDecisionEvents mismatch');
  console.log('autonomy_all_decision_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_all_decision_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

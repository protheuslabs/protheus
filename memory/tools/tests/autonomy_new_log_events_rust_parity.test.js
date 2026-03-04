#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsNewLogEvents(beforeEvidence, afterEvidence) {
  const b = beforeEvidence && beforeEvidence.logs ? beforeEvidence.logs : { run_len: 0, error_len: 0 };
  const a = afterEvidence && afterEvidence.logs ? afterEvidence.logs : { runs: [], errors: [] };
  const runStart = Number(b.run_len || 0);
  const errStart = Number(b.error_len || 0);
  return {
    runs: Array.isArray(a.runs) ? a.runs.slice(runStart) : [],
    errors: Array.isArray(a.errors) ? a.errors.slice(errStart) : []
  };
}

function rustNewLogEvents(beforeEvidence, afterEvidence) {
  const b = beforeEvidence && beforeEvidence.logs ? beforeEvidence.logs : { run_len: 0, error_len: 0 };
  const a = afterEvidence && afterEvidence.logs ? afterEvidence.logs : { runs: [], errors: [] };
  const rust = runBacklogAutoscalePrimitive(
    'new_log_events',
    {
      before_run_len: Number(b.run_len || 0),
      before_error_len: Number(b.error_len || 0),
      after_runs: Array.isArray(a.runs) ? a.runs : [],
      after_errors: Array.isArray(a.errors) ? a.errors : []
    },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return {
    runs: Array.isArray(rust.payload.payload && rust.payload.payload.runs) ? rust.payload.payload.runs : [],
    errors: Array.isArray(rust.payload.payload && rust.payload.payload.errors) ? rust.payload.payload.errors : []
  };
}

function run() {
  const samples = [
    {
      before: { logs: { run_len: 1, error_len: 1 } },
      after: { logs: { runs: [{ id: 'r1' }, { id: 'r2' }], errors: ['e1', 'e2'] } }
    },
    {
      before: { logs: { run_len: -1, error_len: 0 } },
      after: { logs: { runs: [{ id: 'a' }, { id: 'b' }], errors: ['x'] } }
    },
    {
      before: { logs: { run_len: 'bad', error_len: 'bad' } },
      after: { logs: { runs: [{ id: 'only' }], errors: [] } }
    },
    {
      before: null,
      after: { logs: { runs: [], errors: ['e1'] } }
    }
  ];

  for (const s of samples) {
    const expected = jsNewLogEvents(s.before, s.after);
    const got = rustNewLogEvents(s.before, s.after);
    assert.deepStrictEqual(got, expected, `newLogEvents mismatch for sample=${JSON.stringify(s)}`);
  }

  console.log('autonomy_new_log_events_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_new_log_events_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

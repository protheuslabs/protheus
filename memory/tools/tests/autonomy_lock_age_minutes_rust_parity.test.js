#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsLockAgeMinutes(lockTs, nowMs) {
  const ts = Date.parse(String(lockTs || ''));
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / (60 * 1000));
}

function rustLockAgeMinutes(lockTs, nowMs) {
  const rust = runBacklogAutoscalePrimitive(
    'lock_age_minutes',
    { lock_ts: String(lockTs || ''), now_ms: nowMs },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  const age = rust.payload.payload && rust.payload.payload.age_minutes;
  return age == null ? null : Number(age);
}

function nearlyEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function run() {
  const nowMs = Date.parse('2026-03-04T01:00:00.000Z');
  const cases = [
    '2026-03-04T00:00:00.000Z',
    '2026-03-04T01:00:00.000Z',
    'bad-ts',
    ''
  ];

  for (const ts of cases) {
    const expected = jsLockAgeMinutes(ts, nowMs);
    const got = rustLockAgeMinutes(ts, nowMs);
    if (expected == null || got == null) {
      assert.strictEqual(got, expected, `lockAgeMinutes null mismatch for ts=${ts}`);
    } else {
      assert(nearlyEqual(got, expected), `lockAgeMinutes mismatch for ts=${ts}: expected ${expected}, got ${got}`);
    }
  }

  console.log('autonomy_lock_age_minutes_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_lock_age_minutes_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

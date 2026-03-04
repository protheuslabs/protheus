#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsCooldownActiveState(untilMs, nowMs) {
  if (!untilMs || nowMs > untilMs) {
    return { active: false, expired: true };
  }
  return { active: true, expired: false };
}

function rustCooldownActiveState(untilMs, nowMs) {
  const rust = runBacklogAutoscalePrimitive(
    'cooldown_active_state',
    { until_ms: untilMs, now_ms: nowMs },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return {
    active: rust.payload.payload && rust.payload.payload.active === true,
    expired: rust.payload.payload && rust.payload.payload.expired === true
  };
}

function run() {
  const cases = [
    { until: 1200, now: 1000 },
    { until: 1000, now: 1000 },
    { until: 999, now: 1000 },
    { until: 0, now: 1000 },
    { until: NaN, now: 1000 }
  ];

  for (const c of cases) {
    const expected = jsCooldownActiveState(c.until, c.now);
    const got = rustCooldownActiveState(c.until, c.now);
    assert.deepStrictEqual(got, expected, `cooldownActiveState mismatch for ${JSON.stringify(c)}`);
  }

  console.log('autonomy_cooldown_active_state_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_cooldown_active_state_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

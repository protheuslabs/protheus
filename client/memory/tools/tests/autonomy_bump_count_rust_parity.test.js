#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsBumpCount(currentValue) {
  return Number(currentValue || 0) + 1;
}

function rustBumpCount(currentValue) {
  const rust = runBacklogAutoscalePrimitive(
    'bump_count',
    { current_count: Number(currentValue || 0) },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return Number(rust.payload.payload && rust.payload.payload.count || 0);
}

function run() {
  const cases = [undefined, null, 0, 1, 7, '2'];
  for (const c of cases) {
    const expected = jsBumpCount(c);
    const got = rustBumpCount(c);
    assert.strictEqual(got, expected, `bumpCount mismatch for ${String(c)}`);
  }

  console.log('autonomy_bump_count_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_bump_count_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

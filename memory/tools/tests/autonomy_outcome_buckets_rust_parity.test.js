#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsOutcomeBuckets() {
  return { shipped: 0, no_change: 0, reverted: 0 };
}

function rustOutcomeBuckets() {
  const rust = runBacklogAutoscalePrimitive('outcome_buckets', {}, { allow_cli_fallback: true });
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return {
    shipped: Number(rust.payload.payload && rust.payload.payload.shipped || 0),
    no_change: Number(rust.payload.payload && rust.payload.payload.no_change || 0),
    reverted: Number(rust.payload.payload && rust.payload.payload.reverted || 0)
  };
}

function run() {
  const expected = jsOutcomeBuckets();
  const got = rustOutcomeBuckets();
  assert.deepStrictEqual(got, expected, 'outcomeBuckets mismatch');
  console.log('autonomy_outcome_buckets_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_outcome_buckets_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsHashObj(v) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  } catch {
    return null;
  }
}

function rustHashObj(v) {
  let json = null;
  try {
    const encoded = JSON.stringify(v);
    json = encoded == null ? null : String(encoded);
  } catch {
    json = null;
  }
  const rust = runBacklogAutoscalePrimitive(
    'hash_obj',
    { json },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  const hash = rust.payload.payload && rust.payload.payload.hash;
  return hash == null ? null : String(hash);
}

function run() {
  const cases = [
    { a: 1, b: 2 },
    ['x', 2, true],
    'plain-text',
    123,
    null,
    undefined
  ];

  for (const v of cases) {
    const expected = jsHashObj(v);
    const got = rustHashObj(v);
    assert.strictEqual(got, expected, `hashObj mismatch for value=${String(v)}`);
  }

  console.log('autonomy_hash_obj_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_hash_obj_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

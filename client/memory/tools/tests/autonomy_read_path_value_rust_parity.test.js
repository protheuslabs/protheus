#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const obj = {
    meta: {
      nested: {
        score: 12.5,
        label: 'ok'
      }
    }
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsScore = ts.readPathValue(obj, 'meta.nested.score');
  const rustScore = rust.readPathValue(obj, 'meta.nested.score');
  assert.deepStrictEqual(rustScore, tsScore, 'readPathValue score mismatch');

  const tsMiss = ts.readPathValue(obj, 'meta.nested.missing');
  const rustMiss = rust.readPathValue(obj, 'meta.nested.missing');
  assert.deepStrictEqual(rustMiss, tsMiss, 'readPathValue miss mismatch');

  console.log('autonomy_read_path_value_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_read_path_value_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

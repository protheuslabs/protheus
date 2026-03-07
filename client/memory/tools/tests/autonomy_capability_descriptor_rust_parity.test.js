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

function normalize(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    key: String(row.key || ''),
    aliases: Array.isArray(row.aliases) ? row.aliases.map((x) => String(x || '')) : []
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = { type: 'optimization' };
  const actuationSpec = { kind: 'route_execute' };

  const tsOut = normalize(ts.capabilityDescriptor(proposal, actuationSpec));
  const rustOut = normalize(rust.capabilityDescriptor(proposal, actuationSpec));
  assert.deepStrictEqual(rustOut, tsOut, 'capabilityDescriptor mismatch');

  console.log('autonomy_capability_descriptor_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_capability_descriptor_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

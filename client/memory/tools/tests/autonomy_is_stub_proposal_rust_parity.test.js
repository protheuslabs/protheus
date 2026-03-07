#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsIsStubProposal(p) {
  const title = String(p && p.title || '');
  return title.toUpperCase().includes('[STUB]');
}

function rustIsStubProposal(p) {
  const rust = runBacklogAutoscalePrimitive(
    'is_stub_proposal',
    { title: p && p.title == null ? null : String((p && p.title) || '') },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return rust.payload.payload && rust.payload.payload.is_stub === true;
}

function run() {
  const samples = [
    null,
    {},
    { title: '' },
    { title: 'Ship this now' },
    { title: '[STUB] Investigate migration' },
    { title: '[stub] lowercase still stub' },
    { title: 'prefix [STUB] suffix' }
  ];

  for (const p of samples) {
    const expected = jsIsStubProposal(p);
    const got = rustIsStubProposal(p);
    assert.strictEqual(got, expected, `isStubProposal mismatch for p=${JSON.stringify(p)}`);
  }

  console.log('autonomy_is_stub_proposal_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_is_stub_proposal_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    total: Number(row.total || 0),
    eligible: Number(row.eligible || 0),
    blocked: Number(row.blocked || 0),
    blocked_by_reason: Object.fromEntries(Object.entries(row.blocked_by_reason || {}).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposals = [
    { id: 'p1', meta: { admission_preview: { eligible: true } } },
    { id: 'p2', meta: { admission_preview: { eligible: false, blocked_by: ['policy_hold', 'risk'] } } },
    { id: 'p3', meta: { admission_preview: { eligible: false, blocked_by: [] } } },
    { id: 'p4' }
  ];

  const tsOut = normalize(ts.admissionSummaryFromProposals(proposals));
  const rustOut = normalize(rust.admissionSummaryFromProposals(proposals));
  assert.deepStrictEqual(rustOut, tsOut, 'admissionSummaryFromProposals mismatch');

  console.log('autonomy_admission_summary_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_admission_summary_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

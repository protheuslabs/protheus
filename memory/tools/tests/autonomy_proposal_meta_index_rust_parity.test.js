#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsProposalMetaIndex(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const proposalId = String(row && row.proposal_id || '');
    if (!proposalId || seen.has(proposalId)) continue;
    seen.add(proposalId);
    out.push({
      proposal_id: proposalId,
      eye_id: String(row && row.eye_id || ''),
      topics: Array.isArray(row && row.topics)
        ? row.topics.map((t) => String(t || '').toLowerCase()).filter(Boolean)
        : []
    });
  }
  return out;
}

function rustProposalMetaIndex(rows) {
  const rust = runBacklogAutoscalePrimitive(
    'proposal_meta_index',
    { entries: rows },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  const rowsOut = Array.isArray(rust.payload.payload && rust.payload.payload.entries)
    ? rust.payload.payload.entries
    : [];
  return rowsOut.map((row) => ({
    proposal_id: String(row && row.proposal_id || ''),
    eye_id: String(row && row.eye_id || ''),
    topics: Array.isArray(row && row.topics)
      ? row.topics.map((t) => String(t || '').toLowerCase()).filter(Boolean)
      : []
  }));
}

function run() {
  const rows = [
    { proposal_id: 'p1', eye_id: 'eye_a', topics: ['Alpha', 'beta'] },
    { proposal_id: 'p1', eye_id: 'eye_b', topics: ['Gamma'] },
    { proposal_id: 'p2', eye_id: 'eye_c', topics: ['Delta'] },
    { proposal_id: '', eye_id: 'eye_d', topics: ['ignored'] }
  ];

  const expected = jsProposalMetaIndex(rows);
  const got = rustProposalMetaIndex(rows);
  assert.deepStrictEqual(got, expected, 'proposalMetaIndex mismatch');

  console.log('autonomy_proposal_meta_index_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_meta_index_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

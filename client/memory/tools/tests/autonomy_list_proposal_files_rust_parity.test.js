#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsListProposalFiles(entries) {
  return entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function run() {
  const samples = [
    ['README.md', '2026-03-02.json', '2026-03-01.json', '2026-03-01.jsonl'],
    ['bad', '2025-01-03.json', '2025-01-01.json', '2025-01-02.json']
  ];

  for (const entries of samples) {
    const expected = jsListProposalFiles(entries.slice());
    const rust = runBacklogAutoscalePrimitive(
      'list_proposal_files',
      { entries },
      { allow_cli_fallback: true }
    );
    assert(rust && rust.ok === true, 'rust bridge invocation failed');
    assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
    const got = Array.isArray(rust.payload.payload && rust.payload.payload.files)
      ? rust.payload.payload.files.map((v) => String(v || ''))
      : [];
    assert.deepStrictEqual(got, expected, `listProposalFiles mismatch for entries=${JSON.stringify(entries)}`);
  }

  console.log('autonomy_list_proposal_files_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_list_proposal_files_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

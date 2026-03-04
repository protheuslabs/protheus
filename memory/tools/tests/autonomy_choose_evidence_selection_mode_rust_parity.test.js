#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_EVIDENCE_SAMPLE_WINDOW = '3';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const eligible = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const priorRuns = [
    { type: 'autonomy_run', result: 'score_only_preview' },
    { type: 'autonomy_run', result: 'executed' },
    { type: 'autonomy_run', result: 'score_only_evidence' }
  ];

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = ts.chooseEvidenceSelectionMode(eligible, priorRuns, 'evidence');
  const rustOut = rust.chooseEvidenceSelectionMode(eligible, priorRuns, 'evidence');

  assert.deepStrictEqual(rustOut, tsOut, 'chooseEvidenceSelectionMode mismatch');
  console.log('autonomy_choose_evidence_selection_mode_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_choose_evidence_selection_mode_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

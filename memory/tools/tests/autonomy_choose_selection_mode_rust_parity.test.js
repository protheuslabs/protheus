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
    mode: String(row.mode || ''),
    index: Number(row.index || 0),
    explore_used: Number(row.explore_used || 0),
    explore_quota: Number(row.explore_quota || 0),
    exploit_used: Number(row.exploit_used || 0)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const eligible = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const priorRuns = [
    { type: 'autonomy_run', result: 'executed', selection_mode: 'exploit' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'exploit' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'explore' },
    { type: 'autonomy_run', result: 'executed', selection_mode: 'exploit' }
  ];

  const tsOut = normalize(ts.chooseSelectionMode(eligible, priorRuns));
  const rustOut = normalize(rust.chooseSelectionMode(eligible, priorRuns));
  assert.deepStrictEqual(rustOut, tsOut, 'chooseSelectionMode mismatch');

  console.log('autonomy_choose_selection_mode_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_choose_selection_mode_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

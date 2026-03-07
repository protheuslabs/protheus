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
    proposal_id: row.proposal_id == null ? null : String(row.proposal_id),
    decision: String(row.decision || ''),
    source: row.source == null ? null : String(row.source),
    parent_objective_id: row.parent_objective_id == null ? null : String(row.parent_objective_id),
    child_objective_ids: Array.isArray(row.child_objective_ids) ? row.child_objective_ids.map(String) : [],
    edge_count: Number(row.edge_count || 0),
    chain: Array.isArray(row.chain) ? row.chain.map(String) : [],
    dry_run: row.dry_run === true,
    created_count: Number(row.created_count || 0),
    quality_ok: row.quality_ok === true,
    reason: row.reason == null ? null : String(row.reason)
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = { id: 'proposal-9' };
  const action = {
    decision: 'accept',
    objective_id: 'T1_parent',
    source: 'directive_decomposition'
  };
  const summary = {
    created_ids: ['T1_child_a', 'T1_child_b'],
    dry_run: false,
    created_count: 2,
    quality_ok: true,
    reason: null
  };

  const tsOut = normalize(ts.proposalDependencySummary(proposal, action, summary));
  const rustOut = normalize(rust.proposalDependencySummary(proposal, action, summary));
  assert.deepStrictEqual(rustOut, tsOut, 'proposalDependencySummary mismatch');

  console.log('autonomy_proposal_dependency_summary_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_dependency_summary_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

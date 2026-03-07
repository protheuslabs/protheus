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
  const proposal = {
    title: 'Directive Fit Improve',
    type: 'directive_clarification',
    summary: 'Improve objective focus and reduce drift',
    notes: 'manual gate followup',
    expected_impact: 'high',
    risk: 'low',
    validation: ['one metric', 'one rollback'],
    evidence: [
      { match: 'directive objective', evidence_ref: 'eye:directive/1' },
      { match: 'safety check', evidence_ref: 'eye:safety/2' }
    ],
    meta: {
      preview: 'preview text',
      url: 'https://example.com/path',
      normalized_objective: 'improve objective focus',
      normalized_expected_outcome: 'lower drift',
      normalized_validation_metric: 'drift',
      normalized_hint_tokens: ['memory', 'focus'],
      normalized_archetypes: ['alignment'],
      topics: ['quality', 'delivery']
    }
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = String(ts.proposalDirectiveText(proposal));
  const rustOut = String(rust.proposalDirectiveText(proposal));
  assert.strictEqual(rustOut, tsOut, 'proposalDirectiveText mismatch');

  console.log('autonomy_proposal_directive_text_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_proposal_directive_text_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

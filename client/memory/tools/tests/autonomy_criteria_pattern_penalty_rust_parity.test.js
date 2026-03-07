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
  const hits = Array.isArray(row.hit_patterns) ? row.hit_patterns : [];
  return {
    penalty: Number(row.penalty || 0),
    threshold: Number(row.threshold || 0),
    hit_patterns: hits.map((h) => ({
      key: String(h.key || ''),
      failures: Number(h.failures || 0),
      passes: Number(h.passes || 0),
      effective_failures: Number(h.effective_failures || 0),
      penalty: Number(h.penalty || 0)
    }))
  };
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const proposal = {
    type: 'optimization',
    action_spec: {
      success_criteria: ['latency_ms < 200 within 7 days']
    }
  };

  const tsOut = normalize(ts.criteriaPatternPenaltyForProposal(proposal, 'execution'));
  const rustOut = normalize(rust.criteriaPatternPenaltyForProposal(proposal, 'execution'));
  assert.deepStrictEqual(rustOut, tsOut, 'criteriaPatternPenaltyForProposal mismatch');

  console.log('autonomy_criteria_pattern_penalty_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_criteria_pattern_penalty_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

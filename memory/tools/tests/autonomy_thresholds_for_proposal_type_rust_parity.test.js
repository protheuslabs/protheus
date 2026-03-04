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
  const p = out && typeof out === 'object' ? out : {};
  const t = p.thresholds && typeof p.thresholds === 'object' ? p.thresholds : {};
  const offsets = p.offsets && typeof p.offsets === 'object' ? p.offsets : {};
  return {
    thresholds: {
      min_signal_quality: Number(t.min_signal_quality || 0),
      min_sensory_signal_score: Number(t.min_sensory_signal_score || 0),
      min_sensory_relevance_score: Number(t.min_sensory_relevance_score || 0),
      min_directive_fit: Number(t.min_directive_fit || 0),
      min_actionability_score: Number(t.min_actionability_score || 0),
      min_eye_score_ema: Number(t.min_eye_score_ema || 0)
    },
    offsets: {
      min_signal_quality: Number(offsets.min_signal_quality || 0),
      min_sensory_signal_score: Number(offsets.min_sensory_signal_score || 0),
      min_sensory_relevance_score: Number(offsets.min_sensory_relevance_score || 0),
      min_directive_fit: Number(offsets.min_directive_fit || 0),
      min_actionability_score: Number(offsets.min_actionability_score || 0),
      min_eye_score_ema: Number(offsets.min_eye_score_ema || 0)
    }
  };
}

function run() {
  const base = {
    min_signal_quality: 62,
    min_sensory_signal_score: 57,
    min_sensory_relevance_score: 59,
    min_directive_fit: 52,
    min_actionability_score: 56,
    min_eye_score_ema: 54
  };
  const policy = {
    proposal_type_threshold_offsets: {
      optimization: {
        min_signal_quality: -5,
        min_sensory_signal_score: -3,
        min_sensory_relevance_score: -2,
        min_directive_fit: 2,
        min_actionability_score: 1,
        min_eye_score_ema: -1
      }
    }
  };

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = normalize(ts.thresholdsForProposalType(base, 'optimization', policy));
  const rustOut = normalize(rust.thresholdsForProposalType(base, 'optimization', policy));

  assert.deepStrictEqual(rustOut, tsOut, 'thresholdsForProposalType mismatch');
  console.log('autonomy_thresholds_for_proposal_type_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_thresholds_for_proposal_type_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

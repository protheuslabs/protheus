#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const disabledPolicy = { attractor: { enabled: false } };
  const disabledInput = {
    objective: 'Ship safely',
    signature: 'Gate first'
  };

  assert.deepStrictEqual(
    rust.computeAttractorScore(disabledPolicy, disabledInput),
    ts.computeAttractorScore(disabledPolicy, disabledInput),
    'computeAttractorScore mismatch (disabled)'
  );

  const enabledPolicy = {
    attractor: {
      enabled: true,
      weights: {
        objective_specificity: 0.3,
        evidence_backing: 0.2,
        constraint_evidence: 0.15,
        measurable_outcome: 0.1,
        external_grounding: 0.05,
        certainty: 0.1,
        trit_alignment: 0.05,
        impact_alignment: 0.05,
        verbosity_penalty: 0.15
      },
      verbosity: {
        soft_word_cap: 18,
        hard_word_cap: 80,
        low_diversity_floor: 0.22
      },
      min_alignment_by_target: {
        directive: 0.2
      }
    }
  };

  const enabledInput = {
    objective: 'Must reduce drift below 2% within 7 days with measurable latency impact.',
    signature: 'Use github telemetry and external api evidence to improve throughput by 20%.',
    external_signals_count: 3,
    evidence_count: 4,
    effective_certainty: 0.9,
    trit: 1,
    impact: 'high',
    target: 'directive'
  };

  assert.deepStrictEqual(
    rust.computeAttractorScore(enabledPolicy, enabledInput),
    ts.computeAttractorScore(enabledPolicy, enabledInput),
    'computeAttractorScore mismatch (enabled)'
  );

  console.log('inversion_helper_batch9_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch9_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

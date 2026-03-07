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

  const impactInputs = ['low', 'MEDIUM', 'high', 'critical', 'invalid', '', null];
  for (const input of impactInputs) {
    assert.strictEqual(
      rust.normalizeImpact(input),
      ts.normalizeImpact(input),
      `normalizeImpact mismatch for ${String(input)}`
    );
  }

  const modeInputs = ['test', 'live', 'TEST', 'prod', '', null];
  for (const input of modeInputs) {
    assert.strictEqual(
      rust.normalizeMode(input),
      ts.normalizeMode(input),
      `normalizeMode mismatch for ${String(input)}`
    );
  }

  const targetInputs = ['tactical', 'belief', 'identity', 'directive', 'constitution', 'unknown', '', null];
  for (const input of targetInputs) {
    assert.strictEqual(
      rust.normalizeTarget(input),
      ts.normalizeTarget(input),
      `normalizeTarget mismatch for ${String(input)}`
    );
  }

  const resultInputs = ['success', 'neutral', 'fail', 'destructive', 'invalid', '', null];
  for (const input of resultInputs) {
    assert.strictEqual(
      rust.normalizeResult(input),
      ts.normalizeResult(input),
      `normalizeResult mismatch for ${String(input)}`
    );
  }

  const objectiveInputs = [
    'T1_objective-alpha',
    'T2.growth:lane',
    'invalid',
    '',
    null
  ];
  for (const input of objectiveInputs) {
    assert.strictEqual(
      rust.isValidObjectiveId(input),
      ts.isValidObjectiveId(input),
      `isValidObjectiveId mismatch for ${String(input)}`
    );
  }

  const vectorArgs = [
    { trit_vector: [-1, 0, 1] },
    { trit_vector: ['-2', '0', '3'] },
    { trit_vector: '-1, 2, 0, -4' },
    {}
  ];
  for (const input of vectorArgs) {
    assert.deepStrictEqual(
      rust.tritVectorFromInput(input),
      ts.tritVectorFromInput(input),
      `tritVectorFromInput mismatch for ${JSON.stringify(input)}`
    );
  }

  const tokenPairs = [
    { left: ['alpha', 'beta'], right: ['beta', 'gamma'] },
    { left: [], right: [] },
    { left: ['one'], right: [] }
  ];
  for (const sample of tokenPairs) {
    assert.strictEqual(
      rust.jaccardSimilarity(sample.left, sample.right),
      ts.jaccardSimilarity(sample.left, sample.right),
      `jaccardSimilarity mismatch for ${JSON.stringify(sample)}`
    );
  }

  const tritSamples = [
    { query: [1, 1, 0], entry: 1 },
    { query: [0, 0], entry: -1 },
    { query: [], entry: 0 },
    { query: [-1, 1], entry: -1 }
  ];
  for (const sample of tritSamples) {
    assert.strictEqual(
      rust.tritSimilarity(sample.query, sample.entry),
      ts.tritSimilarity(sample.query, sample.entry),
      `tritSimilarity mismatch for ${JSON.stringify(sample)}`
    );
  }

  const policy = {
    certainty_gate: {
      thresholds: {
        novice: { low: 0.2, medium: 0.4, high: 0.6, critical: 0.8 },
        legendary: { low: 0.1, medium: 0.2, high: 0.3, critical: 0.4 }
      },
      allow_zero_for_legendary_critical: true
    },
    maturity: {
      max_target_rank_by_band: {
        novice: 1,
        mature: 3,
        legendary: 5
      }
    },
    impact: {
      max_target_rank: {
        low: 1,
        medium: 2,
        high: 3,
        critical: 4
      }
    }
  };
  const thresholdCases = [
    { band: 'novice', impact: 'medium' },
    { band: 'legendary', impact: 'critical' },
    { band: 'mature', impact: 'high' }
  ];
  for (const sample of thresholdCases) {
    assert.strictEqual(
      rust.certaintyThreshold(policy, sample.band, sample.impact),
      ts.certaintyThreshold(policy, sample.band, sample.impact),
      `certaintyThreshold mismatch for ${JSON.stringify(sample)}`
    );
  }

  const rankCases = [
    { band: 'novice', impact: 'low' },
    { band: 'mature', impact: 'critical' },
    { band: 'legendary', impact: 'medium' }
  ];
  for (const sample of rankCases) {
    assert.strictEqual(
      rust.maxTargetRankForDecision(policy, sample.band, sample.impact),
      ts.maxTargetRankForDecision(policy, sample.band, sample.impact),
      `maxTargetRankForDecision mismatch for ${JSON.stringify(sample)}`
    );
  }

  console.log('inversion_norm_primitives_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_norm_primitives_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

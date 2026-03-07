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
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const capabilitySamples = ['eyes:collector', '  OPS-Lane ', '', null];
  for (const sample of capabilitySamples) {
    assert.strictEqual(
      rust.capabilityCooldownKey(sample),
      ts.capabilityCooldownKey(sample),
      `capabilityCooldownKey mismatch for ${String(sample)}`
    );
  }

  const readinessSamples = [
    ['strategy_a', 'execute'],
    ['strategy_b', 'canary_execute'],
    ['strategy_c', ''],
    ['', 'execute']
  ];
  for (const sample of readinessSamples) {
    assert.strictEqual(
      rust.readinessRetryCooldownKey(sample[0], sample[1]),
      ts.readinessRetryCooldownKey(sample[0], sample[1]),
      `readinessRetryCooldownKey mismatch for ${JSON.stringify(sample)}`
    );
  }

  const proposal = {
    meta: { source_eye: 'eye:market_watch' },
    evidence: [{ ref: 'eye:market_watch digest' }]
  };
  assert.strictEqual(
    rust.sourceEyeId(proposal),
    ts.sourceEyeId(proposal),
    'sourceEyeId mismatch'
  );

  const deprioritizedProposal = {
    meta: { source_eye: 'eye:docs_review' },
    evidence: [{ ref: 'eye:docs_review evidence' }]
  };
  assert.strictEqual(
    rust.isDeprioritizedSourceProposal(deprioritizedProposal),
    ts.isDeprioritizedSourceProposal(deprioritizedProposal),
    'isDeprioritizedSourceProposal mismatch'
  );

  const evidenceRefs = [
    'proof eye:collector_alpha result',
    'none',
    '',
    null
  ];
  for (const sample of evidenceRefs) {
    assert.strictEqual(
      rust.extractEyeFromEvidenceRef(sample),
      ts.extractEyeFromEvidenceRef(sample),
      `extractEyeFromEvidenceRef mismatch for ${String(sample)}`
    );
  }

  const compositeSamples = [
    ['low', 'canary_execute'],
    ['low', 'execute'],
    ['medium', 'canary_execute'],
    ['high', 'execute']
  ];
  for (const sample of compositeSamples) {
    assert.strictEqual(
      rust.compositeEligibilityMin(sample[0], sample[1]),
      ts.compositeEligibilityMin(sample[0], sample[1]),
      `compositeEligibilityMin mismatch for ${JSON.stringify(sample)}`
    );
  }

  const clampSamples = [
    ['min_signal_quality', 12],
    ['min_sensory_signal_score', 90],
    ['min_directive_fit', 20],
    ['unknown', 140]
  ];
  for (const sample of clampSamples) {
    assert.strictEqual(
      rust.clampThreshold(sample[0], sample[1]),
      ts.clampThreshold(sample[0], sample[1]),
      `clampThreshold mismatch for ${JSON.stringify(sample)}`
    );
  }

  const base = {
    min_signal_quality: 52,
    min_sensory_signal_score: 50,
    min_sensory_relevance_score: 49,
    min_directive_fit: 38,
    min_actionability_score: 42,
    min_eye_score_ema: 50
  };
  const deltas = {
    min_signal_quality: 5,
    min_sensory_signal_score: -3,
    min_sensory_relevance_score: 2,
    min_directive_fit: 1,
    min_actionability_score: 4,
    min_eye_score_ema: -2
  };
  assert.deepStrictEqual(
    rust.appliedThresholds(base, deltas),
    ts.appliedThresholds(base, deltas),
    'appliedThresholds mismatch'
  );

  const outcomeBuckets = { shipped: 3, no_change: 1, reverted: 1 };
  assert.strictEqual(
    rust.totalOutcomes(outcomeBuckets),
    ts.totalOutcomes(outcomeBuckets),
    'totalOutcomes mismatch'
  );
  assert.strictEqual(
    rust.deriveEntityBias(outcomeBuckets, 3),
    ts.deriveEntityBias(outcomeBuckets, 3),
    'deriveEntityBias mismatch'
  );

  console.log('autonomy_source_cooldown_helpers_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_source_cooldown_helpers_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

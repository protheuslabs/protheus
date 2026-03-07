#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadController(vars = {}) {
  return withEnv(vars, () => {
    delete require.cache[require.resolve(CONTROLLER_PATH)];
    return require(CONTROLLER_PATH);
  });
}

function run() {
  const strictController = loadController({
    AUTONOMY_SEMANTIC_DEDUPE_ENABLED: '1',
    AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD: '0.6',
    AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS: '4',
    AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE: '1',
    AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT: '1'
  });

  const sameEyeA = strictController.proposalSemanticFingerprint({
    id: 'SEM-A',
    type: 'external_intel',
    title: 'Prepare investor outreach workflow for fintech client',
    summary: 'Build investor pipeline workflow for qualified leads',
    meta: { source_eye: 'x_watch' }
  });
  const sameEyeB = strictController.proposalSemanticFingerprint({
    id: 'SEM-B',
    type: 'external_intel',
    title: 'Build investor outreach workflow for fintech pipeline',
    summary: 'Prepare qualified investor leads workflow',
    meta: { source_eye: 'x_watch' }
  });

  assert.strictEqual(sameEyeA.eligible, true, 'semantic fingerprint should be eligible for rich proposal text');
  assert.strictEqual(sameEyeB.eligible, true, 'semantic fingerprint should be eligible for similar proposal text');
  assert.ok(
    strictController.semanticTokenSimilarity(sameEyeA.token_stems, sameEyeB.token_stems) >= 0.6,
    'similar proposals should meet similarity threshold'
  );

  const matchSameContext = strictController.semanticNearDuplicateMatch(sameEyeB, [sameEyeA], 0.6);
  assert.ok(matchSameContext, 'near-duplicate in same context should match');
  assert.strictEqual(matchSameContext.proposal_id, 'SEM-A', 'match should point to first semantic cluster proposal id');

  const differentContext = strictController.proposalSemanticFingerprint({
    id: 'SEM-C',
    type: 'external_intel',
    title: 'Build investor outreach workflow for fintech pipeline',
    summary: 'Prepare qualified investor leads workflow',
    meta: { source_eye: 'github_watch' }
  });
  const blockedCrossContext = strictController.semanticNearDuplicateMatch(differentContext, [sameEyeA], 0.6);
  assert.strictEqual(blockedCrossContext, null, 'cross-context duplicate should not match when shared-context guard is on');

  const relaxedController = loadController({
    AUTONOMY_SEMANTIC_DEDUPE_ENABLED: '1',
    AUTONOMY_SEMANTIC_DEDUPE_THRESHOLD: '0.6',
    AUTONOMY_SEMANTIC_DEDUPE_MIN_TOKENS: '4',
    AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SAME_TYPE: '1',
    AUTONOMY_SEMANTIC_DEDUPE_REQUIRE_SHARED_CONTEXT: '0'
  });
  const relaxedA = relaxedController.proposalSemanticFingerprint({
    id: 'SEM-R1',
    type: 'external_intel',
    title: 'Build investor outreach workflow for fintech pipeline',
    summary: 'Prepare qualified investor leads workflow',
    meta: { source_eye: 'x_watch' }
  });
  const relaxedB = relaxedController.proposalSemanticFingerprint({
    id: 'SEM-R2',
    type: 'external_intel',
    title: 'Build investor outreach workflow for fintech pipeline',
    summary: 'Prepare qualified investor leads workflow',
    meta: { source_eye: 'github_watch' }
  });
  const relaxedMatch = relaxedController.semanticNearDuplicateMatch(relaxedB, [relaxedA], 0.6);
  assert.ok(relaxedMatch, 'cross-context duplicate should match when shared-context guard is disabled');

  console.log('autonomy_semantic_dedupe.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_semantic_dedupe.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

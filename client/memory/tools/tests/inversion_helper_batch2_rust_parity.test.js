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

  const parseCases = [
    ['run', '--mode=test', '--target', 'belief', '--apply=1'],
    ['record-test', '--result', 'pass', '--safe=1'],
    ['organ', '--max-tests', '5', '--force']
  ];
  for (const argv of parseCases) {
    assert.deepStrictEqual(
      rust.parseArgs(argv),
      ts.parseArgs(argv),
      `parseArgs mismatch for ${JSON.stringify(argv)}`
    );
  }

  const stdoutCases = [
    '{"ok":true,"a":1}',
    'noise\n{"ok":true,"nested":{"x":1}}\n',
    'invalid-json\nline-two'
  ];
  for (const raw of stdoutCases) {
    assert.deepStrictEqual(
      rust.parseJsonFromStdout(raw),
      ts.parseJsonFromStdout(raw),
      `parseJsonFromStdout mismatch for ${raw}`
    );
  }

  const tokenCases = [
    'Alpha beta, gamma',
    'security-first fail closed',
    'one two xx yy zzz'
  ];
  for (const text of tokenCases) {
    assert.deepStrictEqual(
      rust.tokenize(text),
      ts.tokenize(text),
      `tokenize mismatch for ${text}`
    );
  }

  const normListCases = [
    [['A B', 'A-B', 'a_b'], 80],
    ['alpha, beta, alpha, gamma', 80],
    ['', 80]
  ];
  for (const [v, maxLen] of normListCases) {
    assert.deepStrictEqual(
      rust.normalizeList(v, maxLen),
      ts.normalizeList(v, maxLen),
      `normalizeList mismatch for ${JSON.stringify(v)}`
    );
  }

  const textListCases = [
    [[' Alpha ', 'Beta', 'Alpha'], 180, 64],
    ['one, two, one, three', 180, 64]
  ];
  for (const [v, maxLen, maxItems] of textListCases) {
    assert.deepStrictEqual(
      rust.normalizeTextList(v, maxLen, maxItems),
      ts.normalizeTextList(v, maxLen, maxItems),
      `normalizeTextList mismatch for ${JSON.stringify(v)}`
    );
  }

  const query = {
    signature_tokens: ['alpha', 'beta'],
    trit_vector: [1, 1, 0],
    target: 'identity'
  };
  const row = {
    signature_tokens: ['beta', 'gamma'],
    outcome_trit: 1,
    target: 'identity'
  };
  const policy = {
    library: {
      token_weight: 0.5,
      trit_weight: 0.3,
      target_weight: 0.2,
      failed_repetition_similarity_block: 0.72
    }
  };
  assert.strictEqual(
    rust.computeLibraryMatchScore(query, row, policy),
    ts.computeLibraryMatchScore(query, row, policy),
    'computeLibraryMatchScore mismatch'
  );

  const candidates = [
    { row: { outcome_trit: -1 }, similarity: 0.91 },
    { row: { outcome_trit: 0 }, similarity: 0.82 },
    { row: { outcome_trit: -1 }, similarity: 0.42 }
  ];
  assert.deepStrictEqual(
    rust.computeKnownFailurePressure(candidates, policy),
    ts.computeKnownFailurePressure(candidates, policy),
    'computeKnownFailurePressure mismatch'
  );

  const tokenSet = new Set(['memory', 'safety', 'gate', 'optimize']);
  const termCases = ['memory safety', 'optimize', 'unknown phrase'];
  for (const term of termCases) {
    assert.strictEqual(
      rust.hasSignalTermMatch('optimize memory safety gate', tokenSet, term),
      ts.hasSignalTermMatch('optimize memory safety gate', tokenSet, term),
      `hasSignalTermMatch mismatch for ${term}`
    );
  }

  const axiom = {
    signals: {
      action_terms: ['optimize'],
      subject_terms: ['memory safety'],
      object_terms: ['gate']
    },
    min_signal_groups: 2
  };
  assert.deepStrictEqual(
    rust.countAxiomSignalGroups(axiom, 'optimize memory safety gate', tokenSet),
    ts.countAxiomSignalGroups(axiom, 'optimize memory safety gate', tokenSet),
    'countAxiomSignalGroups mismatch'
  );

  const transition = {
    first_live_uses_require_human_veto: { tactical: 2, identity: 1 },
    minimum_first_live_uses_require_human_veto: { tactical: 3, identity: 5 }
  };
  for (const target of ['tactical', 'identity', 'belief']) {
    assert.strictEqual(
      rust.effectiveFirstNHumanVetoUses(transition, target),
      ts.effectiveFirstNHumanVetoUses(transition, target),
      `effectiveFirstNHumanVetoUses mismatch for ${target}`
    );
  }

  console.log('inversion_helper_batch2_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch2_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

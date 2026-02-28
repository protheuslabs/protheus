#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  evaluateTernaryBelief,
  mergeTernaryBeliefs,
  serializeBeliefResult
} = require('../../../lib/ternary_belief_engine.js');

try {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ternary-belief-'));
  const dualityCodexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');
  const dualityPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  fs.mkdirSync(path.dirname(dualityCodexPath), { recursive: true });
  fs.writeFileSync(dualityCodexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability|yang_attrs=novelty,exploration'
  ].join('\n'), 'utf8');
  fs.writeFileSync(dualityPolicyPath, `${JSON.stringify({
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    codex_path: dualityCodexPath,
    state: {
      latest_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history.jsonl')
    },
    integration: {
      belief_formation: true
    }
  }, null, 2)}\n`, 'utf8');
  process.env.DUALITY_SEED_POLICY_PATH = dualityPolicyPath;

  const stableOk = evaluateTernaryBelief([
    { source: 'signal_gate', trit: 1, weight: 3, confidence: 1 },
    { source: 'signal_slo', trit: 1, weight: 3, confidence: 1 },
    { source: 'collector', trit: 0, weight: 1, confidence: 0.8 }
  ]);
  assert.strictEqual(stableOk.trit, 1, 'mostly positive weighted signals should produce +1');
  assert.strictEqual(stableOk.trit_label, 'ok', 'positive belief should label as ok');
  assert.ok(stableOk.confidence > 0.6, 'positive belief should be high confidence');
  assert.ok(stableOk.duality && typeof stableOk.duality.enabled === 'boolean', 'duality advisory should be attached');

  const dominatedPain = evaluateTernaryBelief([
    { source: 'integrity', trit: -1, weight: 5, confidence: 1 },
    { source: 'queue', trit: 1, weight: 1, confidence: 1 },
    { source: 'budget', trit: 0, weight: 1, confidence: 1 }
  ]);
  assert.strictEqual(dominatedPain.trit, -1, 'dominant pain signal should produce -1');
  assert.ok(dominatedPain.score < 0, 'pain-dominant score should be negative');

  const merged = mergeTernaryBeliefs(
    { trit: 1, score: 0.7, confidence: 0.8 },
    { trit: -1, score: -0.9, confidence: 0.95 },
    { mode: 'strict', parent_weight: 1, child_weight: 2 }
  );
  assert.strictEqual(merged.trit, -1, 'strict merge should propagate child pain');
  assert.ok(merged.score < 0, 'weighted merged score should be negative');

  const serialized = serializeBeliefResult(stableOk);
  assert.strictEqual(serialized.schema_id, 'ternary_belief_serialized', 'serialized payload should include schema id');
  assert.strictEqual(serialized.vector.encoding, 'balanced_ternary_sign', 'serialized payload should include ternary vector encoding');
  assert.strictEqual(serialized.vector.values.length, 3, 'serialized carrier vector should contain three carriers');

  const trustWeighted = evaluateTernaryBelief([
    { source: 'high_trust_pain', trit: -1, weight: 1, confidence: 1 },
    { source: 'low_trust_ok', trit: 1, weight: 1, confidence: 1 }
  ], {
    source_trust: {
      high_trust_pain: 1.4,
      low_trust_ok: 0.6
    }
  });
  assert.strictEqual(trustWeighted.trit, -1, 'source trust should influence final trit result');

  const evidenceGuard = evaluateTernaryBelief([
    { source: 'weak_positive', trit: 1, weight: 1, confidence: 0.05 }
  ], {
    min_confidence_for_non_neutral: 0.3,
    min_non_neutral_signals: 1,
    min_non_neutral_weight: 0.9
  });
  assert.strictEqual(evidenceGuard.trit, 0, 'low-confidence non-neutral signal should be neutralized');
  assert.strictEqual(
    evidenceGuard.evidence_guard && evidenceGuard.evidence_guard.insufficient,
    true,
    'evidence guard should mark insufficient evidence'
  );

  console.log('ternary_belief_engine.test.js: OK');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (err) {
  console.error(`ternary_belief_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node

const assert = require('assert');
const { computeCalibrationDeltas } = require('../../../systems/autonomy/autonomy_controller.js');

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   AUTONOMY CALIBRATION TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('low ship-rate + high exhaustion loosens thresholds', () => {
  const d = computeCalibrationDeltas({
    executedCount: 6,
    shippedRate: 0.167,
    noChangeRate: 0.833,
    revertedRate: 0,
    exhausted: 11
  });
  assert.ok(d.min_signal_quality < 0, `expected loosen signal quality, got ${d.min_signal_quality}`);
  assert.ok(d.min_directive_fit < 0, `expected loosen directive fit, got ${d.min_directive_fit}`);
  assert.ok(d.min_actionability_score < 0, `expected loosen actionability, got ${d.min_actionability_score}`);
});

test('tightening requires sufficient sample and shipped baseline', () => {
  const d = computeCalibrationDeltas({
    executedCount: 12,
    shippedRate: 0.33,
    noChangeRate: 0.66,
    revertedRate: 0,
    exhausted: 1
  });
  assert.ok(d.min_signal_quality > 0, `expected tighten signal quality, got ${d.min_signal_quality}`);
  assert.ok(d.min_directive_fit > 0, `expected tighten directive fit, got ${d.min_directive_fit}`);
});

test('small-sample high no-change does not over-tighten', () => {
  const d = computeCalibrationDeltas({
    executedCount: 4,
    shippedRate: 0.25,
    noChangeRate: 0.75,
    revertedRate: 0,
    exhausted: 0
  });
  assert.strictEqual(d.min_signal_quality, 0);
  assert.strictEqual(d.min_directive_fit, 0);
});

test('fallback low-sample exhaustion still loosens slightly', () => {
  const d = computeCalibrationDeltas({
    executedCount: 2,
    shippedRate: 0,
    noChangeRate: 0,
    revertedRate: 0,
    exhausted: 4
  });
  assert.strictEqual(d.min_signal_quality, -1);
  assert.strictEqual(d.min_directive_fit, -1);
});

if (failed) process.exit(1);
console.log('   ✅ ALL AUTONOMY CALIBRATION TESTS PASS');

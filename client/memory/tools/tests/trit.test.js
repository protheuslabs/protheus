#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeTrit,
  tritLabel,
  invertTrit,
  majorityTrit,
  consensusTrit,
  propagateTrit,
  serializeTritVector,
  parseTritVector
} = require('../../../lib/trit.js');

try {
  assert.strictEqual(normalizeTrit('ok'), 1, 'ok should normalize to +1');
  assert.strictEqual(normalizeTrit('pain'), -1, 'pain should normalize to -1');
  assert.strictEqual(normalizeTrit('unknown'), 0, 'unknown should normalize to 0');
  assert.strictEqual(tritLabel(-1), 'pain', 'label for -1 should be pain');
  assert.strictEqual(tritLabel(0), 'unknown', 'label for 0 should be unknown');
  assert.strictEqual(tritLabel(1), 'ok', 'label for +1 should be ok');
  assert.strictEqual(invertTrit(1), -1, 'invert +1 should be -1');
  assert.strictEqual(invertTrit(-1), 1, 'invert -1 should be +1');

  assert.strictEqual(majorityTrit([1, 1, 0, -1]), 1, 'majority should resolve to +1');
  assert.strictEqual(majorityTrit([1, -1], { tie_breaker: 'unknown' }), 0, 'tie should resolve to unknown by default');
  assert.strictEqual(majorityTrit([1, -1], { tie_breaker: 'first_non_zero' }), 1, 'first_non_zero tie breaker should preserve first');
  assert.strictEqual(consensusTrit([1, 1, 0]), 1, 'consensus should ignore neutral and keep sign');
  assert.strictEqual(consensusTrit([1, -1, 0]), 0, 'mixed signs should return unknown consensus');

  assert.strictEqual(propagateTrit(1, 1, { mode: 'strict' }), 1, 'strict +/+ should stay positive');
  assert.strictEqual(propagateTrit(1, -1, { mode: 'strict' }), -1, 'strict should propagate pain');
  assert.strictEqual(propagateTrit(1, -1, { mode: 'permissive' }), 1, 'permissive should preserve positive when present');

  const encoded = serializeTritVector([-1, 0, 1]);
  assert.strictEqual(encoded.digits, '-0+', 'serialized digits should use balanced signs');
  const decoded = parseTritVector(encoded);
  assert.deepStrictEqual(decoded, [-1, 0, 1], 'vector should round-trip');

  console.log('trit.test.js: OK');
} catch (err) {
  console.error(`trit.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

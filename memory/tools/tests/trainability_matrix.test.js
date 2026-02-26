#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  loadTrainabilityMatrixPolicy,
  evaluateTrainingDatumTrainability
} = require(path.join(ROOT, 'lib', 'trainability_matrix.js'));

function run() {
  const policy = loadTrainabilityMatrixPolicy();

  const internalAllowed = evaluateTrainingDatumTrainability({
    source: { provider: 'internal' },
    license: { id: 'internal_protheus' },
    consent: { status: 'granted', mode: 'operator_policy' }
  }, policy);
  assert.strictEqual(internalAllowed.allow, true, 'internal/provider rule should be allowed');

  const unknownDenied = evaluateTrainingDatumTrainability({
    source: { provider: 'unknown_vendor' },
    license: { id: 'internal_protheus' },
    consent: { status: 'granted', mode: 'operator_policy' }
  }, policy);
  assert.strictEqual(unknownDenied.allow, false, 'unknown provider should be default-deny');
  assert.ok(
    Array.isArray(unknownDenied.reasons) && unknownDenied.reasons.includes('unknown_provider_default_deny'),
    'unknown provider deny reason should be explicit'
  );

  const consentDenied = evaluateTrainingDatumTrainability({
    source: { provider: 'internal' },
    license: { id: 'internal_protheus' },
    consent: { status: 'denied', mode: 'operator_policy' }
  }, policy);
  assert.strictEqual(consentDenied.allow, false, 'denied consent should block trainability');
  assert.ok(
    Array.isArray(consentDenied.reasons) && consentDenied.reasons.includes('consent_not_granted'),
    'consent deny should be explicit'
  );

  console.log('trainability_matrix.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`trainability_matrix.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

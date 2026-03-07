#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  loadTrainingConduitPolicy,
  buildTrainingConduitMetadata,
  validateTrainingConduitMetadata
} = require(path.join(ROOT, 'lib', 'training_conduit_schema.js'));

function run() {
  const policy = loadTrainingConduitPolicy();
  const metadata = buildTrainingConduitMetadata({
    ts: '2026-02-26T00:00:00.000Z',
    source_system: 'continuum_core',
    source_channel: 'signal',
    source_path: 'state/nursery/training/continuum_queue.jsonl',
    datum_id: 'cont_test_signal',
    delete_key: 'cont_test_signal',
    classification: 'internal_runtime'
  }, policy);

  const validation = validateTrainingConduitMetadata(metadata, policy);
  assert.strictEqual(validation.ok, true, 'default metadata should validate');
  assert.ok(metadata.source && metadata.source.system, 'source.system should be present');
  assert.ok(metadata.owner && metadata.owner.id, 'owner.id should be present');
  assert.ok(metadata.license && metadata.license.id, 'license.id should be present');
  assert.ok(metadata.consent && metadata.consent.status, 'consent.status should be present');
  assert.ok(metadata.retention && Number(metadata.retention.days) > 0, 'retention.days should be > 0');
  assert.ok(metadata.delete && metadata.delete.key, 'delete.key should be present');

  const broken = {
    source: { system: '', channel: '' },
    owner: { id: '' },
    license: { id: '' },
    consent: { status: '', mode: '' },
    retention: { days: 0 },
    delete: { key: '' }
  };
  const brokenValidation = validateTrainingConduitMetadata(broken, policy);
  assert.strictEqual(brokenValidation.ok, false, 'missing required fields should fail validation');
  assert.ok(
    Array.isArray(brokenValidation.errors) && brokenValidation.errors.length >= 3,
    'invalid metadata should emit detailed errors'
  );

  console.log('training_conduit_schema.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`training_conduit_schema.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

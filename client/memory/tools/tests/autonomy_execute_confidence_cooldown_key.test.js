#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  const objectiveKey = controller.executeConfidenceCooldownKey(
    'route:collector_remediation',
    'T1_make_jay_billionaire_v1',
    'collector_remediation'
  );
  assert.strictEqual(
    objectiveKey,
    'exec_confidence:objective:t1_make_jay_billionaire_v1',
    'objective id should take precedence for execute-confidence cooldown scope'
  );

  const capabilityKey = controller.executeConfidenceCooldownKey(
    'route:collector_remediation',
    '',
    'collector_remediation'
  );
  assert.strictEqual(
    capabilityKey,
    'exec_confidence:capability:route:collector_remediation',
    'capability key should be used when objective id is missing'
  );

  const typeKey = controller.executeConfidenceCooldownKey(
    '',
    '',
    'Collector Remediation'
  );
  assert.strictEqual(
    typeKey,
    'exec_confidence:type:collector_remediation',
    'proposal type should be normalized when capability/objective are absent'
  );

  assert.strictEqual(
    controller.executeConfidenceCooldownKey('', '', ''),
    '',
    'empty inputs should not emit a cooldown key'
  );

  console.log('autonomy_execute_confidence_cooldown_key.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execute_confidence_cooldown_key.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

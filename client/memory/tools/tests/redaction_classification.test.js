#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  classifyAndRedactText,
  classifyTrainingDatum
} = require(path.join(ROOT, 'lib', 'redaction_classification.js'));

function run() {
  const policy = {
    version: '1.0-test',
    enabled: true,
    max_text_bytes: 4096,
    redact_on_block: true,
    text_fields_allowlist: ['failure_reason', 'stderr', 'stdout', 'message'],
    rules: [
      {
        id: 'email',
        category: 'pii',
        action: 'redact',
        regex: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
        flags: 'gi'
      },
      {
        id: 'secret',
        category: 'secret',
        action: 'block',
        regex: '(?:api[_-]?key|token)\\s*[:=]\\s*[A-Za-z0-9_\\-]{8,}',
        flags: 'gi'
      }
    ]
  };

  const textResult = classifyAndRedactText(
    'contact jane@example.com and use api_key=abcd1234efgh5678',
    policy
  );
  assert.strictEqual(textResult.enabled, true);
  assert.strictEqual(textResult.redacted, true, 'email should be redacted');
  assert.strictEqual(textResult.blocked, true, 'secret should trigger block');
  assert.ok(
    String(textResult.sanitized_text || '').includes('[REDACTED:pii]'),
    'pii replacement missing'
  );
  assert.ok(
    String(textResult.sanitized_text || '').includes('[REDACTED:secret]'),
    'secret replacement missing'
  );
  assert.ok(Array.isArray(textResult.findings) && textResult.findings.length >= 2);

  const datumResult = classifyTrainingDatum({
    workflow_id: 'wf_1',
    failure_reason: 'email dev@acme.com',
    message: 'token: qwerty1234567890',
    step_results: [
      { stderr: 'user jane@corp.ai failed' }
    ]
  }, policy);
  assert.strictEqual(datumResult.extracted_field_count > 0, true);
  assert.strictEqual(datumResult.redacted, true);
  assert.strictEqual(datumResult.blocked, true);
  assert.ok(Array.isArray(datumResult.categories) && datumResult.categories.includes('secret'));
  assert.ok(datumResult.evidence && datumResult.evidence.input_sha256, 'missing evidence hashes');

  console.log('redaction_classification.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`redaction_classification.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

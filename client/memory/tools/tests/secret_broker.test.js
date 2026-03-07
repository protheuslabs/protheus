#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_secret_broker');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  process.env.SECRET_BROKER_KEY = 'test_secret_broker_key';
  process.env.MOLTBOOK_TOKEN = 'moltbook_sk_TEST_TOKEN_1234567890';
  process.env.SECRET_BROKER_STATE_PATH = path.join(tmpRoot, 'secret_broker_state.json');
  process.env.SECRET_BROKER_AUDIT_PATH = path.join(tmpRoot, 'secret_broker_audit.jsonl');

  const broker = require('../../../lib/secret_broker.js');

  const issued = broker.issueSecretHandle({
    secret_id: 'moltbook_api_key',
    scope: 'test.scope',
    caller: 'secret_broker_test',
    ttl_sec: 120,
    now_ms: Date.parse('2026-02-21T12:00:00.000Z')
  });
  assert.strictEqual(issued.ok, true, 'issue should succeed');
  assert.ok(String(issued.handle || '').length > 20, 'handle should be non-empty');

  const resolved = broker.resolveSecretHandle(issued.handle, {
    scope: 'test.scope',
    caller: 'secret_broker_test',
    now_ms: Date.parse('2026-02-21T12:00:20.000Z')
  });
  assert.strictEqual(resolved.ok, true, 'resolve should succeed');
  assert.strictEqual(resolved.secret_id, 'moltbook_api_key');
  assert.strictEqual(resolved.value, 'moltbook_sk_TEST_TOKEN_1234567890');

  const scopeMismatch = broker.resolveSecretHandle(issued.handle, {
    scope: 'other.scope',
    caller: 'secret_broker_test',
    now_ms: Date.parse('2026-02-21T12:00:30.000Z')
  });
  assert.strictEqual(scopeMismatch.ok, false, 'scope mismatch should fail');
  assert.strictEqual(scopeMismatch.error, 'scope_mismatch');

  const expired = broker.resolveSecretHandle(issued.handle, {
    scope: 'test.scope',
    caller: 'secret_broker_test',
    now_ms: Date.parse('2026-02-21T12:05:00.000Z')
  });
  assert.strictEqual(expired.ok, false, 'expired handle should fail');
  assert.strictEqual(expired.error, 'handle_expired');

  const state = JSON.parse(fs.readFileSync(process.env.SECRET_BROKER_STATE_PATH, 'utf8'));
  const ids = Object.keys(state.issued || {});
  assert.ok(ids.length >= 1, 'issued handles should be recorded');

  console.log('secret_broker.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`secret_broker.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

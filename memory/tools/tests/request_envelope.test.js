#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  stampGuardEnv,
  verifySignedEnvelopeFromEnv,
  signEnvelope
} = require('../../../lib/request_envelope.js');

function run() {
  const secret = 'test-secret-key';
  const files = ['systems/security/guard.js', 'config/agent_routing_rules.json'];

  const env = stampGuardEnv(
    { REQUEST_GATE_SECRET: secret },
    { source: 'slack', action: 'apply', files, ts: 1735000000, nonce: 'nonce-123' }
  );

  assert.strictEqual(env.REQUEST_SOURCE, 'slack');
  assert.strictEqual(env.REQUEST_ACTION, 'apply');
  assert.strictEqual(env.REQUEST_TS, '1735000000');
  assert.strictEqual(env.REQUEST_NONCE, 'nonce-123');
  assert.ok(/^[a-f0-9]{64}$/.test(String(env.REQUEST_SIG || '')), 'signature should be sha256 hex');

  const ok = verifySignedEnvelopeFromEnv({
    env: { ...env, REQUEST_GATE_SECRET: secret },
    files,
    maxSkewSec: 999999999,
    nowSec: 1735000100
  });
  assert.strictEqual(ok.ok, true, `expected valid signature, got ${ok.reason}`);

  const badSig = verifySignedEnvelopeFromEnv({
    env: { ...env, REQUEST_GATE_SECRET: secret, REQUEST_ACTION: 'propose' },
    files,
    maxSkewSec: 999999999,
    nowSec: 1735000100
  });
  assert.strictEqual(badSig.ok, false);
  assert.strictEqual(badSig.reason, 'signature_mismatch');

  const stale = verifySignedEnvelopeFromEnv({
    env: { ...env, REQUEST_GATE_SECRET: secret },
    files,
    maxSkewSec: 60,
    nowSec: 1735009999
  });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.reason, 'timestamp_skew');

  const unsignedLocal = stampGuardEnv({}, { source: 'local', action: 'apply', files: [] });
  assert.strictEqual(unsignedLocal.REQUEST_SOURCE, 'local');
  assert.strictEqual(unsignedLocal.REQUEST_ACTION, 'apply');
  assert.strictEqual(unsignedLocal.REQUEST_SIG, undefined);

  const manual = signEnvelope(
    {
      source: 'slack',
      action: 'apply',
      ts: 1735000000,
      nonce: 'nonce-123',
      files
    },
    secret
  );
  assert.strictEqual(manual, env.REQUEST_SIG, 'manual signature should match stamped signature');

  console.log('request_envelope.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`request_envelope.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

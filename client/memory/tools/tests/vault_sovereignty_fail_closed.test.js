#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { evaluateVaultPolicy } = require(path.join(ROOT, 'systems', 'vault', 'index.js'));

function fail(msg) {
  console.error(`❌ vault_sovereignty_fail_closed.test.js: ${msg}`);
  process.exit(1);
}

function mustEval(req) {
  const result = evaluateVaultPolicy(req, { prefer_wasm: true, allow_cli_fallback: true });
  if (!result || result.ok !== true || !result.payload || typeof result.payload !== 'object') {
    fail(`rust evaluate failed: ${JSON.stringify(result || {})}`);
  }
  return result.payload;
}

function main() {
  const missingProof = mustEval({
    operation_id: 'fail_closed_zk',
    key_id: 'key_a',
    action: 'unseal',
    zk_proof: null,
    ciphertext_digest: 'sha256:a',
    fhe_noise_budget: 20,
    key_age_hours: 10,
    tamper_signal: false,
    operator_quorum: 2,
    audit_receipt_nonce: 'nonce-a'
  });
  assert.strictEqual(missingProof.allowed, false);
  assert.strictEqual(missingProof.fail_closed, true);
  assert.strictEqual(missingProof.status, 'deny_fail_closed');
  assert.ok(Array.isArray(missingProof.reasons) && missingProof.reasons.some((v) => String(v).includes('vault.zk.required')));

  const tamperWithoutRotate = mustEval({
    operation_id: 'fail_closed_tamper',
    key_id: 'key_b',
    action: 'seal',
    zk_proof: 'zkp:b',
    ciphertext_digest: 'sha256:b',
    fhe_noise_budget: 20,
    key_age_hours: 2,
    tamper_signal: true,
    operator_quorum: 2,
    audit_receipt_nonce: 'nonce-b'
  });
  assert.strictEqual(tamperWithoutRotate.allowed, false);
  assert.strictEqual(tamperWithoutRotate.fail_closed, true);
  assert.strictEqual(tamperWithoutRotate.should_rotate, true);

  const insufficientQuorum = mustEval({
    operation_id: 'fail_closed_quorum',
    key_id: 'key_c',
    action: 'rotate',
    zk_proof: 'zkp:c',
    ciphertext_digest: 'sha256:c',
    fhe_noise_budget: 20,
    key_age_hours: 90,
    tamper_signal: false,
    operator_quorum: 1,
    audit_receipt_nonce: 'nonce-c'
  });
  assert.strictEqual(insufficientQuorum.allowed, false);
  assert.strictEqual(insufficientQuorum.fail_closed, true);
  assert.ok(Array.isArray(insufficientQuorum.reasons) && insufficientQuorum.reasons.some((v) => String(v).includes('vault.rotation.window')));

  console.log('vault_sovereignty_fail_closed.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

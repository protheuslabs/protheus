#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { loadEmbeddedVaultPolicy, evaluateVaultPolicy } = require(path.join(ROOT, 'systems', 'vault', 'index.js'));
const { evaluateVaultPolicyLegacy } = require(path.join(ROOT, 'systems', 'vault', 'legacy_vault.js'));

function fail(msg) {
  console.error(`❌ vault_phase3_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer0/vault/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function normalizeDecision(raw) {
  const rr = Array.isArray(raw && raw.rule_results) ? raw.rule_results : [];
  return {
    policy_id: String(raw && raw.policy_id || ''),
    policy_digest: String(raw && raw.policy_digest || ''),
    operation_id: String(raw && raw.operation_id || ''),
    key_id: String(raw && raw.key_id || ''),
    action: String(raw && raw.action || ''),
    allowed: Boolean(raw && raw.allowed),
    fail_closed: Boolean(raw && raw.fail_closed),
    status: String(raw && raw.status || ''),
    should_rotate: Boolean(raw && raw.should_rotate),
    rotate_reason: raw && raw.rotate_reason != null ? String(raw.rotate_reason) : null,
    reasons: Array.isArray(raw && raw.reasons) ? raw.reasons.map((v) => String(v)) : [],
    rule_results: rr.map((r) => ({
      rule_id: String(r && r.rule_id || ''),
      passed: Boolean(r && r.passed),
      fail_closed: Boolean(r && r.fail_closed),
      reason: String(r && r.reason || '')
    }))
  };
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function buildCase(seed) {
  const rnd = seeded(seed + 11);
  const actions = ['seal', 'unseal', 'rotate'];
  const action = actions[Math.floor(rnd() * actions.length)];
  const hasZk = rnd() > 0.15;
  const hasCipher = rnd() > 0.1;
  const hasAudit = rnd() > 0.08;
  return {
    operation_id: `op_${seed}`,
    key_id: `key_${seed % 4}`,
    action,
    zk_proof: hasZk ? `zkp:${seed}` : null,
    ciphertext_digest: hasCipher ? `sha256:${seed}` : null,
    fhe_noise_budget: Math.floor(rnd() * 28),
    key_age_hours: Math.floor(rnd() * 120),
    tamper_signal: rnd() > 0.8,
    operator_quorum: Math.floor(rnd() * 4),
    audit_receipt_nonce: hasAudit ? `nonce-${seed}` : null
  };
}

function main() {
  ensureReleaseBinary();

  const loaded = loadEmbeddedVaultPolicy({ prefer_wasm: true, allow_cli_fallback: true });
  if (!loaded || loaded.ok !== true || !loaded.payload || typeof loaded.payload !== 'object') {
    fail(`unable to load policy via rust core: ${JSON.stringify(loaded || {})}`);
  }
  const policy = loaded.payload;

  const fixedCases = [
    {
      operation_id: 'base_allow',
      key_id: 'key_base',
      action: 'seal',
      zk_proof: 'zkp:base',
      ciphertext_digest: 'sha256:base',
      fhe_noise_budget: 20,
      key_age_hours: 12,
      tamper_signal: false,
      operator_quorum: 2,
      audit_receipt_nonce: 'nonce-base'
    },
    {
      operation_id: 'tamper_denied',
      key_id: 'key_tamper',
      action: 'seal',
      zk_proof: 'zkp:tamper',
      ciphertext_digest: 'sha256:tamper',
      fhe_noise_budget: 20,
      key_age_hours: 4,
      tamper_signal: true,
      operator_quorum: 2,
      audit_receipt_nonce: 'nonce-t'
    },
    {
      operation_id: 'quorum_denied',
      key_id: 'key_rotate',
      action: 'rotate',
      zk_proof: 'zkp:rotate',
      ciphertext_digest: 'sha256:rotate',
      fhe_noise_budget: 20,
      key_age_hours: 90,
      tamper_signal: false,
      operator_quorum: 1,
      audit_receipt_nonce: 'nonce-r'
    }
  ];

  const requests = fixedCases.concat(Array.from({ length: 50 }, (_, i) => buildCase(i)));

  for (const req of requests) {
    const rustResult = evaluateVaultPolicy(req, { prefer_wasm: true, allow_cli_fallback: true });
    if (!rustResult || rustResult.ok !== true || !rustResult.payload || typeof rustResult.payload !== 'object') {
      fail(`rust evaluate failed for ${req.operation_id}: ${JSON.stringify(rustResult || {})}`);
    }

    const legacy = evaluateVaultPolicyLegacy(req, policy);
    const rustDecision = normalizeDecision(rustResult.payload);
    const legacyDecision = normalizeDecision(legacy);
    assert.deepStrictEqual(rustDecision, legacyDecision, `parity mismatch for ${req.operation_id}`);
  }

  console.log('vault_phase3_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

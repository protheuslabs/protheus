#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const {
  loadEmbeddedVaultPolicy,
  evaluateVaultPolicy
} = require('./index.js');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function policyDigest(policy: AnyObj) {
  if (policy && typeof policy === 'object' && cleanText((policy as AnyObj).policy_digest || '', 200)) {
    return cleanText((policy as AnyObj).policy_digest, 200);
  }
  return crypto.createHash('sha256').update(JSON.stringify(policy || {}), 'utf8').digest('hex');
}

function loadLegacyVaultPolicy(input?: AnyObj) {
  if (input && typeof input === 'object' && Object.keys(input).length > 0) {
    return input;
  }
  const loaded = loadEmbeddedVaultPolicy({
    prefer_wasm: true,
    allow_cli_fallback: true
  });
  if (loaded && loaded.ok === true && loaded.payload && typeof loaded.payload === 'object') {
    return loaded.payload;
  }
  return {
    policy_id: 'vault_policy_unavailable',
    version: 0,
    rules: []
  };
}

function evaluateVaultPolicyLegacy(inputReq: AnyObj, _inputPolicy?: AnyObj) {
  const result = evaluateVaultPolicy(inputReq, {
    prefer_wasm: true,
    allow_cli_fallback: true
  });
  if (result && result.ok === true && result.payload && typeof result.payload === 'object') {
    return result.payload;
  }
  return {
    policy_id: 'vault_policy_unavailable',
    policy_digest: policyDigest(_inputPolicy && typeof _inputPolicy === 'object' ? _inputPolicy : {}),
    operation_id: cleanText(inputReq && (inputReq as AnyObj).operation_id, 160),
    key_id: cleanText(inputReq && (inputReq as AnyObj).key_id, 160),
    action: cleanText(inputReq && (inputReq as AnyObj).action, 64).toLowerCase(),
    allowed: false,
    fail_closed: true,
    status: 'deny_fail_closed',
    should_rotate: false,
    rotate_reason: null,
    reasons: ['vault_legacy_wrapper_rust_eval_failed'],
    rule_results: []
  };
}

module.exports = {
  loadLegacyVaultPolicy,
  evaluateVaultPolicyLegacy,
  policyDigest
};

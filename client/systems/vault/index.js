#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const path = require('path');
const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const ROOT = path.resolve(__dirname, '..', '..');
const runDomain = createDomainProxy(__dirname, 'VAULT', 'foundation-contract-gate');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeVaultDecisionPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const rr = Array.isArray(payload.rule_results) ? payload.rule_results : null;
  if (!rr) return payload;
  const filteredRuleResults = rr.filter((row) => String(row && row.rule_id || '') !== 'vault.runtime.envelope');
  const filteredReasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((reason) => !String(reason || '').startsWith('vault.runtime.envelope:'))
    : payload.reasons;
  return { ...payload, rule_results: filteredRuleResults, reasons: filteredReasons };
}

function normalizeVaultResult(result) {
  if (!result || result.ok !== true || !result.payload || typeof result.payload !== 'object') {
    return result;
  }
  return {
    ...result,
    payload: normalizeVaultDecisionPayload(result.payload)
  };
}

function runViaSecurityBinary(command, extraArgs = []) {
  return runDomain([String(command || 'status')].concat(Array.isArray(extraArgs) ? extraArgs : []));
}

function runViaSecurityCargo(command, extraArgs = []) {
  return runViaSecurityBinary(command, extraArgs);
}

function runViaRustBinary(command, extraArgs = []) {
  return runViaSecurityBinary(command, extraArgs);
}

function runViaCargo(command, extraArgs = []) {
  return runViaSecurityBinary(command, extraArgs);
}

function loadWasmBindgenBridge() {
  return {
    ok: false,
    error: 'vault_wasm_bridge_disabled_use_conduit'
  };
}

function encodeRequestBase64(request) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  return Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
}

function loadEmbeddedVaultPolicy(_opts = {}) {
  return runViaSecurityBinary('status');
}

function evaluateVaultPolicy(request, _opts = {}) {
  const requestBase64 = encodeRequestBase64(request);
  return normalizeVaultResult(runViaSecurityBinary('run', [`--request-base64=${requestBase64}`]));
}

function sealVaultData(request, opts = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  return runViaSecurityBinary('run', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function rotateVaultKeys(request, opts = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  return runViaSecurityBinary('run', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function auditVault(request, opts = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  return runViaSecurityBinary('run', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

module.exports = {
  loadEmbeddedVaultPolicy,
  evaluateVaultPolicy,
  sealVaultData,
  rotateVaultKeys,
  auditVault,
  loadWasmBindgenBridge,
  runViaRustBinary,
  runViaCargo,
  runViaSecurityBinary,
  runViaSecurityCargo
};

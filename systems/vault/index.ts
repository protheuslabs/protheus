#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SECURITY_MANIFEST = path.join(ROOT, 'crates', 'security', 'Cargo.toml');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function normalizeVaultDecisionPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return payload;
  const rr = Array.isArray(payload.rule_results) ? payload.rule_results : null;
  if (!rr) return payload;
  const filteredRuleResults = rr.filter((row: any) => String(row && row.rule_id || '') !== 'vault.runtime.envelope');
  const filteredReasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((reason: any) => !String(reason || '').startsWith('vault.runtime.envelope:'))
    : payload.reasons;
  return {
    ...payload,
    rule_results: filteredRuleResults,
    reasons: filteredReasons
  };
}

function normalizeVaultResult(result: any) {
  if (!result || result.ok !== true || !result.payload || typeof result.payload !== 'object') {
    return result;
  }
  return {
    ...result,
    payload: normalizeVaultDecisionPayload(result.payload)
  };
}

function securityBinaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_SECURITY_CORE_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'security_core'),
    path.join(ROOT, 'target', 'debug', 'security_core'),
    path.join(ROOT, 'crates', 'security', 'target', 'release', 'security_core'),
    path.join(ROOT, 'crates', 'security', 'target', 'debug', 'security_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runViaSecurityBinary(command: string, extraArgs: string[] = []) {
  for (const candidate of securityBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, [command, ...extraArgs], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'security_bin', binary_path: candidate, payload };
      }
    } catch {
      // keep trying fallback candidates
    }
  }
  return { ok: false, error: 'security_binary_unavailable' };
}

function runViaSecurityCargo(command: string, extraArgs: string[] = []) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    SECURITY_MANIFEST,
    '--bin',
    'security_core',
    '--',
    command,
    ...extraArgs
  ];
  const out = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && payload && typeof payload === 'object') {
    return { ok: true, engine: 'security_cargo', payload };
  }
  return {
    ok: false,
    error: `security_cargo_run_failed:${cleanText(out.stderr || out.stdout || '', 220)}`
  };
}

// Backward-compatible exports for older callsites that referenced vault-side runners.
function runViaRustBinary(command: string, extraArgs: string[] = []) {
  return runViaSecurityBinary(command, extraArgs);
}

function runViaCargo(command: string, extraArgs: string[] = []) {
  return runViaSecurityCargo(command, extraArgs);
}

function loadWasmBindgenBridge() {
  return {
    ok: false,
    error: 'vault_wasm_bridge_disabled_use_security_core'
  };
}

function encodeRequestBase64(request: unknown) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  return Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
}

function loadEmbeddedVaultPolicy(opts: AnyObj = {}) {
  const allowCliFallback = opts.allow_cli_fallback !== false;
  const binResult = runViaSecurityBinary('vault-load-policy');
  if (binResult.ok) return binResult;
  if (!allowCliFallback) return binResult;
  return runViaSecurityCargo('vault-load-policy');
}

function evaluateVaultPolicy(request: unknown, opts: AnyObj = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const allowCliFallback = opts.allow_cli_fallback !== false;
  const binResult = runViaSecurityBinary('vault-evaluate', [`--request-base64=${requestBase64}`]);
  if (binResult.ok) return normalizeVaultResult(binResult);
  if (!allowCliFallback) return binResult;
  return normalizeVaultResult(runViaSecurityCargo('vault-evaluate', [`--request-base64=${requestBase64}`]));
}

function sealVaultData(request: unknown, opts: AnyObj = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const binResult = runViaSecurityBinary('seal', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (binResult.ok) return binResult;
  return runViaSecurityCargo('seal', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function rotateVaultKeys(request: unknown, opts: AnyObj = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const binResult = runViaSecurityBinary('rotate-all', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (binResult.ok) return binResult;
  return runViaSecurityCargo('rotate-all', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function auditVault(request: unknown, opts: AnyObj = {}) {
  const requestBase64 = encodeRequestBase64(request);
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const binResult = runViaSecurityBinary('audit', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (binResult.ok) return binResult;
  return runViaSecurityCargo('audit', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
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

#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VAULT_MANIFEST = path.join(ROOT, 'crates', 'vault', 'Cargo.toml');
const SECURITY_MANIFEST = path.join(ROOT, 'crates', 'security', 'Cargo.toml');

let cachedWasmBinding: any = null;
let cachedWasmPath = '';
let cachedWasmErr = '';

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
  const decision = payload;
  const rr = Array.isArray(decision.rule_results) ? decision.rule_results : null;
  if (!rr) return decision;
  const filteredRuleResults = rr.filter((row: any) => String(row && row.rule_id || '') !== 'vault.runtime.envelope');
  const filteredReasons = Array.isArray(decision.reasons)
    ? decision.reasons.filter((reason: any) => !String(reason || '').startsWith('vault.runtime.envelope:'))
    : decision.reasons;
  return {
    ...decision,
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

function wasmCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_VAULT_WASM_BINDING_PATH || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'crates', 'vault', 'pkg', 'protheus_vault_core_v1.js'),
    path.join(ROOT, 'crates', 'vault', 'pkg-node', 'protheus_vault_core_v1.js')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function loadWasmBindgenBridge() {
  if (cachedWasmBinding) {
    return { ok: true, binding: cachedWasmBinding, module_path: cachedWasmPath };
  }
  if (cachedWasmErr) {
    return { ok: false, error: cachedWasmErr };
  }

  const candidates = wasmCandidates();
  const errs: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        errs.push(`missing:${candidate}`);
        continue;
      }
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(candidate);
      const evaluate = mod && (mod.evaluate_vault_policy_wasm || mod.evaluateVaultPolicyWasm);
      const load = mod && (mod.load_embedded_vault_policy_wasm || mod.loadEmbeddedVaultPolicyWasm);
      if (typeof evaluate !== 'function' || typeof load !== 'function') {
        errs.push(`invalid_exports:${candidate}`);
        continue;
      }
      cachedWasmBinding = { evaluate, load };
      cachedWasmPath = candidate;
      cachedWasmErr = '';
      return { ok: true, binding: cachedWasmBinding, module_path: candidate };
    } catch (err) {
      errs.push(`load_failed:${candidate}:${cleanText(err && (err as any).message, 100)}`);
    }
  }

  cachedWasmErr = errs.length ? errs[0] : 'wasm_bindgen_bridge_unavailable';
  return { ok: false, error: cachedWasmErr };
}

function binaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_VAULT_RUST_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'vault_core'),
    path.join(ROOT, 'target', 'debug', 'vault_core'),
    path.join(ROOT, 'crates', 'vault', 'target', 'release', 'vault_core'),
    path.join(ROOT, 'crates', 'vault', 'target', 'debug', 'vault_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
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

function runViaRustBinary(command: string, extraArgs: string[] = []) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, [command, ...extraArgs], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (out.status === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'rust_bin', binary_path: candidate, payload };
      }
    } catch {
      // keep trying
    }
  }
  return { ok: false, error: 'rust_binary_unavailable' };
}

function runViaCargo(command: string, extraArgs: string[] = []) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    VAULT_MANIFEST,
    '--bin',
    'vault_core',
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
    return { ok: true, engine: 'rust_cargo', payload };
  }
  return {
    ok: false,
    error: `cargo_run_failed:${cleanText(out.stderr || out.stdout || '', 200)}`
  };
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
      if (out.status === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'security_bin', binary_path: candidate, payload };
      }
    } catch {
      // keep trying
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
    error: `security_cargo_run_failed:${cleanText(out.stderr || out.stdout || '', 200)}`
  };
}

function runLoadViaWasm() {
  const bridge = loadWasmBindgenBridge();
  if (!bridge.ok || !bridge.binding || typeof bridge.binding.load !== 'function') {
    return { ok: false, error: bridge.error || 'wasm_bindgen_bridge_unavailable' };
  }
  try {
    const raw = bridge.binding.load();
    const payload = parseJsonPayload(raw);
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'wasm_bindgen_invalid_payload' };
    }
    return { ok: true, engine: 'rust_wasm_bindgen', module_path: bridge.module_path, payload };
  } catch (err) {
    return {
      ok: false,
      error: `wasm_bindgen_call_failed:${cleanText(err && (err as any).message, 160)}`
    };
  }
}

function runEvaluateViaWasm(requestJson: string) {
  const bridge = loadWasmBindgenBridge();
  if (!bridge.ok || !bridge.binding || typeof bridge.binding.evaluate !== 'function') {
    return { ok: false, error: bridge.error || 'wasm_bindgen_bridge_unavailable' };
  }
  try {
    const raw = bridge.binding.evaluate(String(requestJson || '{}'));
    const payload = parseJsonPayload(raw);
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'wasm_bindgen_invalid_payload' };
    }
    return { ok: true, engine: 'rust_wasm_bindgen', module_path: bridge.module_path, payload };
  } catch (err) {
    return {
      ok: false,
      error: `wasm_bindgen_call_failed:${cleanText(err && (err as any).message, 160)}`
    };
  }
}

function loadEmbeddedVaultPolicy(opts: AnyObj = {}) {
  const preferSecurity = opts.prefer_security !== false;
  const preferWasm = opts.prefer_wasm !== false;
  const allowCliFallback = opts.allow_cli_fallback !== false;

  if (preferSecurity) {
    const secBin = runViaSecurityBinary('vault-load-policy');
    if (secBin.ok) return secBin;
    if (allowCliFallback) {
      const secCargo = runViaSecurityCargo('vault-load-policy');
      if (secCargo.ok) return secCargo;
    }
    if (!allowCliFallback) return secBin;
  }

  if (preferWasm) {
    const wasmResult = runLoadViaWasm();
    if (wasmResult.ok) return wasmResult;
    if (!allowCliFallback) return wasmResult;
  }

  const binResult = runViaRustBinary('load-policy');
  if (binResult.ok) return binResult;

  if (!allowCliFallback) return binResult;
  return runViaCargo('load-policy');
}

function evaluateVaultPolicy(request: unknown, opts: AnyObj = {}) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');

  const preferSecurity = opts.prefer_security !== false;
  const preferWasm = opts.prefer_wasm !== false;
  const allowCliFallback = opts.allow_cli_fallback !== false;

  if (preferSecurity) {
    const secBin = runViaSecurityBinary('vault-evaluate', [`--request-base64=${requestBase64}`]);
    if (secBin.ok) return normalizeVaultResult(secBin);
    if (allowCliFallback) {
      const secCargo = runViaSecurityCargo('vault-evaluate', [`--request-base64=${requestBase64}`]);
      if (secCargo.ok) return normalizeVaultResult(secCargo);
    }
    if (!allowCliFallback) return secBin;
  }

  if (preferWasm) {
    const wasmResult = runEvaluateViaWasm(requestJson);
    if (wasmResult.ok) return normalizeVaultResult(wasmResult);
    if (!allowCliFallback) return wasmResult;
  }

  const binResult = runViaRustBinary('evaluate', [`--request-base64=${requestBase64}`]);
  if (binResult.ok) return normalizeVaultResult(binResult);

  if (!allowCliFallback) return binResult;
  return normalizeVaultResult(runViaCargo('evaluate', [`--request-base64=${requestBase64}`]));
}

function sealVaultData(request: unknown, opts: AnyObj = {}) {
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');

  const bin = runViaSecurityBinary('seal', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (bin.ok) return bin;
  return runViaSecurityCargo('seal', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function rotateVaultKeys(request: unknown, opts: AnyObj = {}) {
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');

  const bin = runViaSecurityBinary('rotate-all', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (bin.ok) return bin;
  return runViaSecurityCargo('rotate-all', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
}

function auditVault(request: unknown, opts: AnyObj = {}) {
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');

  const bin = runViaSecurityBinary('audit', [`--request-base64=${requestBase64}`, `--state-root=${stateRoot}`]);
  if (bin.ok) return bin;
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

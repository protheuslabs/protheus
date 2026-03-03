#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SECURITY_MANIFEST = path.join(ROOT, 'crates', 'security', 'Cargo.toml');

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

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function binaryCandidates() {
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

function runViaRustBinary(command: string, requestJson: string, stateRoot: string) {
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  const extra = command === 'enforce' ? [`--state-root=${stateRoot}`] : [];

  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, [command, `--request-base64=${requestBase64}`, ...extra], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'rust_bin', binary_path: candidate, payload };
      }
    } catch {
      // continue scanning candidates
    }
  }

  return { ok: false, error: 'rust_security_binary_unavailable' };
}

function runViaCargo(command: string, requestJson: string, stateRoot: string) {
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  const extra = command === 'enforce' ? [`--state-root=${stateRoot}`] : [];
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    SECURITY_MANIFEST,
    '--bin',
    'security_core',
    '--',
    command,
    `--request-base64=${requestBase64}`,
    ...extra
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
    error: `cargo_security_run_failed:${cleanText(out.stderr || out.stdout || '', 220)}`
  };
}

type SecurityGateOptions = {
  enforce?: boolean,
  state_root?: string,
  allow_fallback?: boolean
};

function normalizeRequest(request: any) {
  const input = request && typeof request === 'object' ? request : {};
  const now = Date.now();
  return {
    operation_id: cleanText(input.operation_id || `op_${now}`, 160),
    subsystem: cleanText(input.subsystem || 'system', 80),
    action: cleanText(input.action || 'execute', 80),
    actor: cleanText(input.actor || 'runtime', 80),
    risk_class: cleanText(input.risk_class || 'normal', 40),
    payload_digest: cleanText(input.payload_digest || `sha256:${stableHash(JSON.stringify(input), 32)}`, 160),
    tags: Array.isArray(input.tags) ? input.tags.map((v: unknown) => cleanText(v, 80)).filter(Boolean) : [],
    covenant_violation: Boolean(input.covenant_violation),
    tamper_signal: Boolean(input.tamper_signal),
    key_age_hours: Number.isFinite(Number(input.key_age_hours)) ? Math.max(0, Number(input.key_age_hours)) : 1,
    operator_quorum: Number.isFinite(Number(input.operator_quorum)) ? Math.max(0, Number(input.operator_quorum)) : 2,
    audit_receipt_nonce: cleanText(input.audit_receipt_nonce || `nonce-${stableHash(`${now}-${Math.random()}`, 12)}`, 120),
    zk_proof: cleanText(input.zk_proof || 'zk-proof-default', 220),
    ciphertext_digest: cleanText(input.ciphertext_digest || input.payload_digest || `sha256:${stableHash(JSON.stringify(input), 32)}`, 220)
  };
}

function evaluateSecurityGate(request: unknown, opts: SecurityGateOptions = {}) {
  if (String(process.env.PROTHEUS_SECURITY_GATE_BYPASS || '').trim() === '1') {
    return {
      ok: true,
      bypassed: true,
      decision: {
        ok: true,
        fail_closed: false,
        reason: 'security_gate_bypass_env'
      }
    };
  }

  const enforce = opts.enforce !== false;
  const command = enforce ? 'enforce' : 'check';
  const stateRoot = cleanText(opts.state_root || path.join(ROOT, 'state'), 500);
  const requestPayload = normalizeRequest(request);
  const requestJson = JSON.stringify(requestPayload);

  const binResult = runViaRustBinary(command, requestJson, stateRoot);
  if (binResult.ok) {
    return { ...binResult, request: requestPayload };
  }

  if (opts.allow_fallback === false) {
    return { ok: false, error: binResult.error || 'security_gate_failed', request: requestPayload };
  }

  const cargoResult = runViaCargo(command, requestJson, stateRoot);
  return { ...cargoResult, request: requestPayload };
}

function assertOperationAllowed(request: unknown, opts: SecurityGateOptions = {}) {
  const result = evaluateSecurityGate(request, opts);
  if (!result.ok) {
    const msg = cleanText((result as any).error || 'security_gate_unavailable', 280);
    throw new Error(`security_gate_execution_failed:${msg}`);
  }
  const payload = (result as any).payload || {};
  const decision = payload && payload.decision && typeof payload.decision === 'object'
    ? payload.decision
    : null;
  if (!decision || decision.ok !== true || decision.fail_closed === true) {
    const reason = decision && Array.isArray(decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 240)
      : 'deny';
    throw new Error(`security_gate_blocked:${reason}`);
  }
  return result;
}

module.exports = {
  evaluateSecurityGate,
  assertOperationAllowed,
  normalizeRequest
};

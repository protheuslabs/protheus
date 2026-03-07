#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { evaluateSecurityGate } = require('../security/rust_security_gate.js');

const ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_MANIFEST = path.join(ROOT, 'crates', 'memory', 'Cargo.toml');
const MEMORY_AMBIENT_SCRIPT = path.join(ROOT, 'systems', 'memory', 'ambient.js');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function stableHash(v, len = 24) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function envBool(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function memorySecurityGateEnabled(opts = {}) {
  if (opts.security_gate_enabled === false) return false;
  const env = String(process.env.PROTHEUS_MEMORY_SECURITY_GATE || '').trim().toLowerCase();
  if (!env) return true;
  if (['0', 'false', 'no', 'off'].includes(env)) return false;
  if (['1', 'true', 'yes', 'on'].includes(env)) return true;
  return true;
}

function memoryCompatModeEnabled(opts = {}) {
  if (opts.compat_mode === true) return true;
  return envBool('PROTHEUS_MEMORY_COMPAT_MODE', false);
}

function memoryAmbientEnabled(opts = {}) {
  if (opts.ambient_mode === false) return false;
  return envBool('PROTHEUS_MEMORY_AMBIENT_MODE', true);
}

function buildMemorySecurityRequest(command, args, opts = {}) {
  const digest = `sha256:${stableHash(JSON.stringify([command, ...(args || [])]), 32)}`;
  return {
    operation_id: cleanText(opts.operation_id || `memory_${command}_${stableHash(`${Date.now()}_${digest}`, 14)}`, 160),
    subsystem: 'memory',
    action: cleanText(command || 'memory_op', 80),
    actor: cleanText(opts.actor || 'systems/memory/index.ts', 120),
    risk_class: cleanText(opts.risk_class || 'normal', 40),
    payload_digest: digest,
    tags: ['memory', 'rust_core_v6', 'foundation_lock'],
    covenant_violation: Boolean(opts.covenant_violation),
    tamper_signal: Boolean(opts.tamper_signal),
    key_age_hours: Number.isFinite(Number(opts.key_age_hours)) ? Math.max(0, Number(opts.key_age_hours)) : 1,
    operator_quorum: Number.isFinite(Number(opts.operator_quorum)) ? Math.max(0, Number(opts.operator_quorum)) : 2,
    audit_receipt_nonce: cleanText(opts.audit_receipt_nonce || `nonce-${stableHash(`${digest}_${Date.now()}`, 12)}`, 120),
    zk_proof: cleanText(opts.zk_proof || 'zk-memory-default', 220),
    ciphertext_digest: cleanText(opts.ciphertext_digest || digest, 220)
  };
}

function evaluateMemorySecurityGate(command, args, opts = {}) {
  if (!memorySecurityGateEnabled(opts)) {
    return { ok: true, skipped: true, reason: 'memory_security_gate_disabled' };
  }
  const stateRoot = cleanText(opts.state_root
    || process.env.PROTHEUS_SECURITY_STATE_ROOT
    || path.join(ROOT, 'state'), 500);
  const request = buildMemorySecurityRequest(command, args, opts);
  const gate = evaluateSecurityGate(request, {
    enforce: opts.security_enforce !== false,
    state_root: stateRoot,
    allow_fallback: opts.security_allow_fallback !== false
  });
  if (!gate || gate.ok !== true) {
    return {
      ok: false,
      reason: cleanText(gate && gate.error || 'security_gate_execution_failed', 220),
      gate
    };
  }
  const payload = gate.payload && typeof gate.payload === 'object' ? gate.payload : {};
  const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision : null;
  if (!decision || decision.ok !== true || decision.fail_closed === true) {
    const reason = Array.isArray(decision && decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 220)
      : 'security_gate_blocked';
    return {
      ok: false,
      reason,
      gate
    };
  }
  return {
    ok: true,
    gate
  };
}

function binaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_MEMORY_CORE_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'memory-cli'),
    path.join(ROOT, 'target', 'debug', 'memory-cli'),
    path.join(ROOT, 'crates', 'memory', 'target', 'release', 'memory-cli'),
    path.join(ROOT, 'crates', 'memory', 'target', 'debug', 'memory-cli')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runLegacyMemoryCli(command, args = [], timeoutMs = 180000) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, [command, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: Math.max(1000, timeoutMs),
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && payload && typeof payload === 'object') {
        return {
          ok: true,
          engine: 'rust_bin_compat',
          binary_path: candidate,
          payload,
          stdout: String(out.stdout || ''),
          stderr: String(out.stderr || ''),
          status: Number.isFinite(out.status) ? Number(out.status) : 1
        };
      }
    } catch {
      // continue
    }
  }

  const cargoArgs = [
    'run',
    '--quiet',
    '--manifest-path',
    MEMORY_MANIFEST,
    '--bin',
    'memory-cli',
    '--',
    command,
    ...args
  ];
  const out = spawnSync('cargo', cargoArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && payload && typeof payload === 'object') {
    return {
      ok: true,
      engine: 'rust_cargo_compat',
      payload,
      stdout: String(out.stdout || ''),
      stderr: String(out.stderr || ''),
      status: Number.isFinite(out.status) ? Number(out.status) : 1
    };
  }
  return {
    ok: false,
    engine: 'rust_compat_failed',
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    error: `memory_cli_failed:${cleanText(out.stderr || out.stdout || '', 220)}`
  };
}

function runMemoryAmbientCli(command, args = [], timeoutMs = 180000, opts = {}) {
  const ambientArgs = [
    'run',
    `--memory-command=${String(command)}`,
    ...args.map((entry) => `--memory-arg=${String(entry)}`)
  ];
  const runContext = cleanText(opts.run_context || opts.runContext || process.env.MEMORY_RUN_CONTEXT || 'memory_surface', 80);
  if (runContext) {
    ambientArgs.push(`--run-context=${runContext}`);
  }

  const out = spawnSync(process.execPath, [MEMORY_AMBIENT_SCRIPT, ...ambientArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(opts.env || {})
          .map(([key, value]) => [String(key), String(value)])
      )
    }
  });

  const status = Number.isFinite(out.status) ? Number(out.status) : 1;
  const stdout = String(out.stdout || '');
  const stderr = String(out.stderr || '');
  const receipt = parseJsonPayload(stdout);

  if (status === 0 && receipt && typeof receipt === 'object') {
    return {
      ok: receipt.ok !== false,
      status,
      engine: 'memory_ambient_conduit',
      receipt,
      stdout,
      stderr
    };
  }

  return {
    ok: false,
    status,
    engine: 'memory_ambient_conduit',
    receipt: receipt && typeof receipt === 'object' ? receipt : null,
    stdout,
    stderr,
    error: `memory_ambient_failed:${cleanText(stderr || stdout || '', 240)}`
  };
}

function runMemoryCli(command, args = [], timeoutMs = 180000, opts = {}) {
  const securityGate = evaluateMemorySecurityGate(command, args, opts);
  if (!securityGate.ok) {
    return {
      ok: false,
      engine: 'security_gate_fail_closed',
      error: `security_gate_blocked:${cleanText(securityGate.reason || 'deny', 220)}`,
      payload: null,
      security_gate: securityGate.gate || null
    };
  }

  const compatMode = memoryCompatModeEnabled(opts);
  const ambientMode = memoryAmbientEnabled(opts);

  if (ambientMode) {
    const ambient = runMemoryAmbientCli(command, args, timeoutMs, opts);
    if (ambient.ok && ambient.receipt && ambient.receipt.memory_payload && typeof ambient.receipt.memory_payload === 'object') {
      return {
        ok: ambient.receipt.memory_payload.ok === true,
        engine: ambient.engine,
        payload: ambient.receipt.memory_payload,
        ambient_receipt: ambient.receipt,
        status: ambient.status,
        stdout: ambient.stdout,
        stderr: ambient.stderr,
        security_gate: securityGate.gate || null
      };
    }
    if (!compatMode) {
      return {
        ok: false,
        engine: ambient.engine,
        error: cleanText((ambient.receipt && ambient.receipt.reason) || ambient.error || 'memory_ambient_fail_closed', 260),
        payload: ambient.receipt,
        ambient_receipt: ambient.receipt,
        status: ambient.status,
        stdout: ambient.stdout,
        stderr: ambient.stderr,
        security_gate: securityGate.gate || null
      };
    }
  }

  const legacy = runLegacyMemoryCli(command, args, timeoutMs);
  if (legacy.ok) {
    return {
      ok: true,
      engine: legacy.engine,
      binary_path: legacy.binary_path,
      payload: legacy.payload,
      status: legacy.status,
      stdout: legacy.stdout,
      stderr: legacy.stderr,
      security_gate: securityGate.gate || null,
      compatibility_mode: true
    };
  }

  return {
    ok: false,
    engine: legacy.engine,
    error: legacy.error || 'memory_compat_cli_failed',
    payload: null,
    status: legacy.status,
    stdout: legacy.stdout,
    stderr: legacy.stderr,
    security_gate: securityGate.gate || null,
    compatibility_mode: true
  };
}

function recall(query, limit = 5) {
  return runMemoryCli('recall', [`--query=${cleanText(query, 400)}`, `--limit=${Math.max(1, Number(limit) || 5)}`]);
}

function ingest(id, content, tags = [], repetitions = 1, lambda = 0.02) {
  const tagArg = (Array.isArray(tags) ? tags : []).map((v) => cleanText(v, 80)).filter(Boolean).join(',');
  return runMemoryCli('ingest', [
    `--id=${cleanText(id || `memory://${Date.now()}`, 160)}`,
    `--content=${cleanText(content, 4000)}`,
    `--tags=${tagArg}`,
    `--repetitions=${Math.max(1, Number(repetitions) || 1)}`,
    `--lambda=${Number.isFinite(Number(lambda)) ? Number(lambda) : 0.02}`
  ]);
}

function get(id) {
  return runMemoryCli('get', [`--id=${cleanText(id, 200)}`]);
}

function compress(aggressive = false) {
  return runMemoryCli('compress', [`--aggressive=${aggressive ? '1' : '0'}`]);
}

function ebbinghausScore(ageDays, repetitions = 1, lambda = 0.02) {
  return runMemoryCli('ebbinghaus-score', [
    `--age-days=${Number.isFinite(Number(ageDays)) ? Number(ageDays) : 0}`,
    `--repetitions=${Math.max(1, Number(repetitions) || 1)}`,
    `--lambda=${Number.isFinite(Number(lambda)) ? Number(lambda) : 0.02}`
  ]);
}

function crdtExchange(payload) {
  const encoded = JSON.stringify(payload && typeof payload === 'object' ? payload : { left: {}, right: {} });
  return runMemoryCli('crdt-exchange', [`--payload=${encoded}`]);
}

function loadEmbeddedHeartbeat() {
  return runMemoryCli('load-embedded-heartbeat');
}

function loadEmbeddedObservabilityProfile() {
  return runMemoryCli('load-embedded-observability-profile');
}

function loadEmbeddedVaultPolicy() {
  return runMemoryCli('load-embedded-vault-policy');
}

module.exports = {
  runMemoryCli,
  recall,
  ingest,
  get,
  compress,
  ebbinghausScore,
  crdtExchange,
  loadEmbeddedHeartbeat,
  loadEmbeddedObservabilityProfile,
  loadEmbeddedVaultPolicy
};

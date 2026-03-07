#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const crypto = require('crypto');
const { evaluateSecurityGate } = require('../security/rust_security_gate.js');
const { createDomainProxy } = require('../../lib/legacy_conduit_proxy');

const ROOT = path.resolve(__dirname, '..', '..');
const runExecutionDomain = createDomainProxy(__dirname, 'EXECUTION', 'execution-yield-recovery');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableHash(v: unknown, len = 24) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function boolOpt(raw: unknown, fallback: boolean) {
  if (raw == null) return fallback;
  if (typeof raw === 'boolean') return raw;
  const txt = cleanText(raw, 16).toLowerCase();
  if (txt === '1' || txt === 'true' || txt === 'yes' || txt === 'on') return true;
  if (txt === '0' || txt === 'false' || txt === 'no' || txt === 'off') return false;
  return fallback;
}

function executionSecurityGateEnabled(opts: AnyObj = {}) {
  if (opts.security_gate_enabled === false) return false;
  const env = process.env.PROTHEUS_EXECUTION_SECURITY_GATE;
  return boolOpt(env, true);
}

function buildSecurityGateRequest(yaml: string, opts: AnyObj = {}) {
  const digest = `sha256:${stableHash(yaml, 32)}`;
  return {
    operation_id: cleanText(opts.operation_id || `execution_run_${stableHash(`${Date.now()}_${yaml}`, 18)}`, 160),
    subsystem: 'execution',
    action: cleanText(opts.action || 'run_workflow', 80),
    actor: cleanText(opts.actor || 'systems/execution/index.ts', 120),
    risk_class: cleanText(opts.risk_class || 'normal', 40),
    payload_digest: digest,
    tags: ['execution', 'workflow', 'rust_core'],
    covenant_violation: Boolean(opts.covenant_violation),
    tamper_signal: Boolean(opts.tamper_signal),
    key_age_hours: Number.isFinite(Number(opts.key_age_hours)) ? Math.max(0, Number(opts.key_age_hours)) : 1,
    operator_quorum: Number.isFinite(Number(opts.operator_quorum)) ? Math.max(0, Number(opts.operator_quorum)) : 2,
    audit_receipt_nonce: cleanText(opts.audit_receipt_nonce || `nonce-${stableHash(`${digest}_${Date.now()}`, 12)}`, 120),
    zk_proof: cleanText(opts.zk_proof || 'zk-execution-default', 220),
    ciphertext_digest: cleanText(opts.ciphertext_digest || digest, 220)
  };
}

function securityBlockedReceipt(yaml: string, reason: string, gateResult: any = null) {
  let workflowId = 'security_gate_blocked';
  try {
    const parsed = JSON.parse(String(yaml || '{}'));
    if (parsed && typeof parsed === 'object' && parsed.workflow_id) {
      workflowId = cleanText(parsed.workflow_id, 160) || workflowId;
    }
  } catch {
    // best-effort workflow id extraction only
  }
  const eventDigest = stableHash(`${workflowId}|${reason}|deny`, 64);
  return {
    workflow_id: workflowId,
    status: 'failed',
    deterministic: true,
    replayable: false,
    processed_steps: 0,
    pause_reason: reason,
    event_digest: eventDigest,
    events: [`error:${reason}`],
    state: {
      cursor: 0,
      paused: false,
      completed: false,
      last_step_id: null,
      processed_step_ids: [],
      processed_events: 0,
      digest: eventDigest
    },
    metadata: {},
    warnings: [reason],
    security_gate: gateResult && gateResult.payload && gateResult.payload.decision
      ? gateResult.payload.decision
      : null
  };
}

function evaluateExecutionSecurityGate(yaml: string, opts: AnyObj = {}) {
  if (!executionSecurityGateEnabled(opts)) {
    return { ok: true, skipped: true, reason: 'execution_security_gate_disabled' };
  }

  const stateRoot = cleanText(
    opts.state_root
      || process.env.PROTHEUS_SECURITY_STATE_ROOT
      || path.join(ROOT, 'state'),
    500
  );
  const request = buildSecurityGateRequest(yaml, opts);
  const result = evaluateSecurityGate(request, {
    enforce: opts.security_enforce !== false,
    state_root: stateRoot,
    allow_fallback: opts.security_allow_fallback !== false
  });
  if (!result || result.ok !== true) {
    return {
      ok: false,
      reason: cleanText(result && result.error || 'security_gate_execution_failed', 220),
      result
    };
  }

  const payload = result.payload && typeof result.payload === 'object' ? result.payload : {};
  const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision : null;
  if (!decision || decision.ok !== true || decision.fail_closed === true) {
    const denyReason = Array.isArray(decision && decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 220)
      : 'security_gate_blocked';
    return {
      ok: false,
      reason: denyReason || 'security_gate_blocked',
      result
    };
  }

  return {
    ok: true,
    result
  };
}

function loadWasmBindgenBridge() {
  return {
    ok: false,
    error: 'execution_wasm_bridge_disabled_use_conduit'
  };
}

function runViaConduit(yaml: string) {
  const encoded = Buffer.from(String(yaml || ''), 'utf8').toString('base64');
  const out = runExecutionDomain(['run', `--yaml-base64=${encoded}`]);
  if (out && out.ok === true && out.payload && typeof out.payload === 'object') {
    return { ok: true, engine: 'conduit', payload: out.payload };
  }
  return {
    ok: false,
    engine: 'conduit',
    error: cleanText((out && out.error) || 'execution_domain_failed', 220),
    payload: out && out.payload && typeof out.payload === 'object' ? out.payload : null
  };
}

function runViaRustBinary(yaml: string) {
  return runViaConduit(yaml);
}

function runViaCargo(yaml: string) {
  return runViaConduit(yaml);
}

function runViaWasm(yaml: string) {
  void yaml;
  const bridge = loadWasmBindgenBridge();
  return { ok: false, error: bridge.error || 'wasm_bindgen_bridge_unavailable' };
}

function runWorkflow(yamlOrSpec: unknown, opts: AnyObj = {}) {
  const yaml = typeof yamlOrSpec === 'string'
    ? yamlOrSpec
    : JSON.stringify(yamlOrSpec && typeof yamlOrSpec === 'object' ? yamlOrSpec : {});

  const preferWasm = opts.prefer_wasm !== false;
  const allowCliFallback = opts.allow_cli_fallback !== false;
  const securityGate = evaluateExecutionSecurityGate(yaml, opts);
  if (!securityGate.ok) {
    const reason = cleanText(securityGate.reason || 'security_gate_blocked', 220);
    return {
      ok: true,
      engine: 'security_gate_fail_closed',
      security_gate: securityGate.result || null,
      payload: securityBlockedReceipt(yaml, reason, securityGate.result || null)
    };
  }

  if (preferWasm) {
    const wasmResult = runViaWasm(yaml);
    if (wasmResult.ok) return { ...wasmResult, security_gate: securityGate.result || null };
    if (!allowCliFallback) return wasmResult;
  }

  const binResult = runViaRustBinary(yaml);
  if (binResult.ok) return { ...binResult, security_gate: securityGate.result || null };

  if (!allowCliFallback) return binResult;
  const cargoResult = runViaCargo(yaml);
  if (cargoResult && cargoResult.ok === true) {
    return { ...cargoResult, security_gate: securityGate.result || null };
  }
  return cargoResult;
}

module.exports = {
  runWorkflow,
  loadWasmBindgenBridge,
  runViaWasm,
  runViaRustBinary,
  runViaCargo
};

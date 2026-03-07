#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const crypto = require('crypto');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableHash(v, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function normalizeRequest(request) {
  const input = request && typeof request === 'object' ? request : {};
  const now = Date.now();
  return {
    operation_id: cleanText(input.operation_id || `op_${now}`, 160),
    subsystem: cleanText(input.subsystem || 'system', 80),
    action: cleanText(input.action || 'execute', 80),
    actor: cleanText(input.actor || 'runtime', 80),
    risk_class: cleanText(input.risk_class || 'normal', 40),
    payload_digest: cleanText(input.payload_digest || `sha256:${stableHash(JSON.stringify(input), 32)}`, 160),
    tags: Array.isArray(input.tags) ? input.tags.map((v) => cleanText(v, 80)).filter(Boolean) : [],
    covenant_violation: Boolean(input.covenant_violation),
    tamper_signal: Boolean(input.tamper_signal),
    key_age_hours: Number.isFinite(Number(input.key_age_hours)) ? Math.max(0, Number(input.key_age_hours)) : 1,
    operator_quorum: Number.isFinite(Number(input.operator_quorum)) ? Math.max(0, Number(input.operator_quorum)) : 2,
    audit_receipt_nonce: cleanText(input.audit_receipt_nonce || `nonce-${stableHash(`${now}-${Math.random()}`, 12)}`, 120),
    zk_proof: cleanText(input.zk_proof || 'zk-proof-default', 220),
    ciphertext_digest: cleanText(input.ciphertext_digest || input.payload_digest || `sha256:${stableHash(JSON.stringify(input), 32)}`, 220)
  };
}

function localDecision(request) {
  const reasons = [];
  let ok = true;
  let failClosed = false;

  if (request.covenant_violation === true) {
    ok = false;
    failClosed = true;
    reasons.push('covenant_violation');
  }
  if (request.tamper_signal === true) {
    ok = false;
    failClosed = true;
    reasons.push('tamper_signal');
  }

  const risk = String(request.risk_class || '').toLowerCase();
  const quorum = Number(request.operator_quorum || 0);
  if ((risk === 'high' || risk === 'critical') && quorum < 2) {
    ok = false;
    failClosed = true;
    reasons.push('insufficient_operator_quorum');
  }

  if (Number(request.key_age_hours || 0) > 72) {
    ok = false;
    failClosed = true;
    reasons.push('stale_key_age');
  }

  if (reasons.length === 0) {
    reasons.push('policy_allow_local_conduit_mode');
  }

  return {
    ok,
    fail_closed: failClosed,
    reasons
  };
}

function evaluateSecurityGate(request, opts = {}) {
  if (String(process.env.PROTHEUS_SECURITY_GATE_BYPASS || '').trim() === '1') {
    return {
      ok: true,
      bypassed: true,
      engine: 'conduit_policy_local',
      payload: {
        ok: true,
        decision: {
          ok: true,
          fail_closed: false,
          reasons: ['security_gate_bypass_env']
        }
      }
    };
  }

  const requestPayload = normalizeRequest(request);
  const decision = localDecision(requestPayload);
  const payload = {
    ok: true,
    type: 'security_gate_local_policy',
    decision,
    receipt_hash: stableHash(JSON.stringify({ requestPayload, decision }), 32)
  };

  return {
    ok: true,
    engine: 'conduit_policy_local',
    payload,
    request: requestPayload,
    enforce: opts.enforce !== false
  };
}

function assertOperationAllowed(request, opts = {}) {
  const result = evaluateSecurityGate(request, opts);
  if (!result.ok) {
    const msg = cleanText(result.error || 'security_gate_unavailable', 280);
    throw new Error(`security_gate_execution_failed:${msg}`);
  }
  const payload = result.payload || {};
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

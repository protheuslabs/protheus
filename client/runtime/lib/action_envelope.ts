#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

const ACTION_TYPES = {
  RESEARCH: 'research',
  CODE_CHANGE: 'code_change',
  PUBLISH_PUBLICLY: 'publish_publicly',
  SPEND_MONEY: 'spend_money',
  CHANGE_CREDENTIALS: 'change_credentials',
  DELETE_DATA: 'delete_data',
  OUTBOUND_CONTACT_NEW: 'outbound_contact_new',
  OUTBOUND_CONTACT_EXISTING: 'outbound_contact_existing',
  DEPLOYMENT: 'deployment',
  OTHER: 'other'
};

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'action_envelope', 'action-envelope-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `action_envelope_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `action_envelope_kernel_${command}_failed`);
    return { ok: false, error: message || `action_envelope_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `action_envelope_kernel_${command}_bridge_failed`
      : `action_envelope_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function createActionEnvelope(input) {
  const out = invoke('create', {
    input: input && typeof input === 'object' ? input : {}
  });
  return out.envelope && typeof out.envelope === 'object' ? out.envelope : null;
}

function generateActionId() {
  const out = invoke('generate-id', {});
  return String(out.action_id || '').trim();
}

function classifyAction({ toolName = null, commandText = null, payload = {} } = {}) {
  const out = invoke('classify', {
    tool_name: toolName,
    command_text: commandText,
    payload: payload && typeof payload === 'object' ? payload : {}
  });
  return out.classification && typeof out.classification === 'object'
    ? out.classification
    : {
        type: ACTION_TYPES.OTHER,
        risk: RISK_LEVELS.MEDIUM,
        confidence: 'low',
        matched_pattern: null
      };
}

function requiresApprovalByDefault(type) {
  const out = invoke('requires-approval', { type });
  return out.requires_approval === true;
}

function detectIrreversible(commandText) {
  const out = invoke('detect-irreversible', { command_text: commandText });
  return out.result && typeof out.result === 'object'
    ? out.result
    : { is_irreversible: false };
}

function autoClassifyAndCreate({ toolName = null, commandText = null, payload = {}, summary = null } = {}) {
  const out = invoke('auto-classify', {
    tool_name: toolName,
    command_text: commandText,
    payload: payload && typeof payload === 'object' ? payload : {},
    summary
  });
  return out.envelope && typeof out.envelope === 'object' ? out.envelope : null;
}

module.exports = {
  ACTION_TYPES,
  RISK_LEVELS,
  createActionEnvelope,
  classifyAction,
  autoClassifyAndCreate,
  requiresApprovalByDefault,
  detectIrreversible,
  generateActionId
};

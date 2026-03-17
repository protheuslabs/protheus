#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only. User-facing formatting stays local.

const os = require('os');
const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = process.env.APPROVAL_GATE_QUEUE_PATH
  ? path.resolve(process.env.APPROVAL_GATE_QUEUE_PATH)
  : process.env.PROTHEUS_APPROVAL_GATE_QUEUE_PATH
    ? path.resolve(process.env.PROTHEUS_APPROVAL_GATE_QUEUE_PATH)
    : path.join(REPO_ROOT, 'local', 'state', 'approvals_queue.yaml');
process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
const bridge = createOpsLaneBridge(__dirname, 'approval_gate', 'approval-gate-kernel');

function defaultQueue() {
  return { pending: [], approved: [], denied: [], history: [] };
}

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function queuePathFlag() {
  return { 'queue-path': QUEUE_FILE };
}

function invokeApprovalGate(command, flags = {}) {
  const args = [command];
  const merged = { ...queuePathFlag(), ...(flags || {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value == null) continue;
    args.push(`--${key}=${value}`);
  }
  const out = bridge.run(args);
  const rawPayload = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payload = rawPayload && rawPayload.payload && typeof rawPayload.payload === 'object'
    ? rawPayload.payload
    : rawPayload;
  return {
    ok: !!(payload && payload.ok === true),
    out,
    payload,
  };
}

function generateApprovalMessage(entry) {
  const row = entry && typeof entry === 'object' ? entry : {};
  return `Action: ${row.summary || ''}
Type: ${row.type || row.entry_type || ''}
Directive: ${row.directive_id || 'T0_invariants'}
Why gated: ${row.reason || ''}
Action ID: ${row.action_id || ''}

To approve, reply: APPROVE ${row.action_id || ''}
To deny, reply: DENY ${row.action_id || ''}`;
}

function loadQueue() {
  const call = invokeApprovalGate('status');
  if (!call.payload || !call.payload.queue) return defaultQueue();
  return call.payload.queue;
}

function saveQueue(queue) {
  const call = invokeApprovalGate('replace', {
    'payload-base64': encodeBase64(JSON.stringify({ queue: queue || defaultQueue() })),
  });
  if (!call.payload || call.payload.ok !== true) {
    throw new Error(
      call.payload && (call.payload.error || call.payload.reason)
        ? String(call.payload.error || call.payload.reason)
        : 'approval_gate_replace_failed'
    );
  }
}

function parseQueueYaml(content) {
  const call = invokeApprovalGate('parse-yaml', {
    'text-base64': encodeBase64(content),
  });
  if (!call.payload || !call.payload.queue) return defaultQueue();
  return call.payload.queue;
}

function queueForApproval(actionEnvelope, reason) {
  const envelope = actionEnvelope && typeof actionEnvelope === 'object' ? actionEnvelope : {};
  const call = invokeApprovalGate('queue', {
    'payload-base64': encodeBase64(
      JSON.stringify({
        action_envelope: envelope,
        reason: String(reason == null ? '' : reason),
      })
    ),
  });
  if (!call.payload || !call.payload.result) {
    return {
      success: false,
      action_id: envelope.action_id || null,
      message: 'Approval queue unavailable',
      error:
        call.payload && (call.payload.error || call.payload.reason)
          ? String(call.payload.error || call.payload.reason)
          : 'approval_gate_queue_failed',
    };
  }
  return call.payload.result;
}

function approveAction(actionId) {
  const call = invokeApprovalGate('approve', { 'action-id': actionId });
  if (!call.payload || !call.payload.result) {
    return {
      success: false,
      error:
        call.payload && (call.payload.error || call.payload.reason)
          ? String(call.payload.error || call.payload.reason)
          : `Action ${actionId} not found in pending queue`,
    };
  }
  return call.payload.result;
}

function denyAction(actionId, reason = 'User denied') {
  const call = invokeApprovalGate('deny', {
    'action-id': actionId,
    reason: String(reason),
  });
  if (!call.payload || !call.payload.result) {
    return {
      success: false,
      error:
        call.payload && (call.payload.error || call.payload.reason)
          ? String(call.payload.error || call.payload.reason)
          : `Action ${actionId} not found in pending queue`,
    };
  }
  return call.payload.result;
}

function wasApproved(actionId) {
  const call = invokeApprovalGate('was-approved', { 'action-id': actionId });
  return !!(call.payload && call.payload.approved === true);
}

function formatBlockedResponse(validationResult) {
  return `📦 [ACTION BLOCKED]

• Reason: ${validationResult.blocked_reason}
• Tier: ${validationResult.effective_constraints?.tier || 0}
• Action ID: ${validationResult.action_id}

This action violates invariant constraints and cannot proceed.`;
}

function formatApprovalRequiredResponse(queueResult) {
  return `📦 [APPROVAL REQUIRED]

${queueResult.message}

Reply: APPROVE ${queueResult.action_id}`;
}

function parseApprovalCommand(text) {
  const call = invokeApprovalGate('parse-command', {
    'text-base64': encodeBase64(text),
  });
  if (!call.payload || !call.payload.command) return null;
  return call.payload.command;
}

module.exports = {
  QUEUE_FILE,
  queueForApproval,
  approveAction,
  denyAction,
  wasApproved,
  loadQueue,
  saveQueue,
  parseQueueYaml,
  formatBlockedResponse,
  formatApprovalRequiredResponse,
  parseApprovalCommand,
  generateApprovalMessage,
};

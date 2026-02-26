#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(root, 'systems', 'workflow', 'client_communication_organ.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-comm-'));
  const policyPath = path.join(tmp, 'config', 'client_communication_policy.json');
  const statePath = path.join(tmp, 'state', 'client_communication_state.json');
  const historyPath = path.join(tmp, 'state', 'client_communication_history.jsonl');
  const inboundPath = path.join(tmp, 'state', 'client_communication_inbound.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    channels: {
      default: {
        followup_hours: [24],
        retry_backoff_sec: [300, 900],
        escalation_hours: [24, 72],
        max_followups: 2
      },
      upwork: {
        followup_hours: [24, 72],
        retry_backoff_sec: [900, 1800, 3600],
        escalation_hours: [24, 72, 168],
        max_followups: 2
      }
    },
    human_gate: {
      enabled: true,
      require_gate_channels: ['upwork'],
      high_value_confidence_threshold: 0.7,
      high_risk_levels: ['high', 'critical']
    }
  });

  const nowMs = 1760000100000;
  const opts = { policyPath, statePath, historyPath, inboundPath };
  const gated = mod.prepareCommunicationAttempt({
    workflow_id: 'wf_comm',
    objective_id: 'obj_comm',
    channel: 'upwork',
    adapter: 'upwork_message',
    provider: 'upwork_api',
    high_value_confidence: 0.95,
    risk: 'high',
    now_ms: nowMs
  }, opts);

  assert.strictEqual(gated.ok, false, 'high-value/high-risk upwork should require human gate');
  assert.strictEqual(gated.reason, 'communication_human_gate_required', 'gate reason should be explicit');
  assert.strictEqual(gated.requires_human_gate, true, 'gate flag should be true');

  const approved = mod.prepareCommunicationAttempt({
    workflow_id: 'wf_comm',
    objective_id: 'obj_comm',
    channel: 'upwork',
    adapter: 'upwork_message',
    provider: 'upwork_api',
    high_value_confidence: 0.95,
    risk: 'high',
    human_approved: true,
    now_ms: nowMs + (60 * 1000)
  }, opts);

  assert.strictEqual(approved.ok, true, 'human-approved send should pass');
  assert.strictEqual(approved.allowed, true, 'send should be allowed');
  assert.ok(approved.thread_id, 'thread id should be returned');

  const failed = mod.finalizeCommunicationAttempt({
    thread_id: approved.thread_id,
    ok: false,
    failure_reason: 'network_timeout',
    now_ms: nowMs + (2 * 60 * 1000)
  }, opts);

  assert.strictEqual(failed.ok, true, 'finalize should persist');
  assert.strictEqual(failed.status, 'retry_pending', 'failed send should queue retry');
  assert.ok(failed.retry_backoff_until, 'retry backoff should be set');

  const recovered = mod.finalizeCommunicationAttempt({
    thread_id: approved.thread_id,
    ok: true,
    now_ms: nowMs + (3 * 60 * 1000)
  }, opts);

  assert.strictEqual(recovered.ok, true, 'recovery finalize should persist');
  assert.strictEqual(recovered.status, 'sent', 'success should set sent state');

  const state = mod.loadState(statePath);
  assert.ok(state && state.threads && typeof state.threads === 'object', 'thread state should persist');
  assert.ok(state.threads[approved.thread_id], 'thread should exist in state');

  assert.ok(fs.existsSync(historyPath), 'history should be emitted');
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 3, 'expected gate + preflight + result events');
}

run();

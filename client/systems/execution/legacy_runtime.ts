#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const { runWorkflow } = require('./index.js');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableHash(lines: string[]) {
  const h = crypto.createHash('sha256');
  for (let i = 0; i < lines.length; i += 1) {
    h.update(`${i}:${lines[i]}|`, 'utf8');
  }
  return h.digest('hex');
}

function normalizeReceipt(raw: AnyObj) {
  const state = raw && raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    workflow_id: cleanText(raw && raw.workflow_id, 160) || 'invalid_workflow',
    status: cleanText(raw && raw.status, 40) || 'failed',
    deterministic: Boolean(raw && raw.deterministic !== false),
    replayable: Boolean(raw && raw.replayable),
    processed_steps: Number.isFinite(Number(raw && raw.processed_steps))
      ? Math.max(0, Math.floor(Number(raw.processed_steps)))
      : 0,
    pause_reason: raw && raw.pause_reason ? cleanText(raw.pause_reason, 220) : null,
    event_digest: cleanText(raw && raw.event_digest, 128),
    events: Array.isArray(raw && raw.events)
      ? raw.events.map((row: unknown) => cleanText(row, 280)).filter(Boolean)
      : [],
    state: {
      cursor: Number.isFinite(Number(state.cursor)) ? Math.max(0, Math.floor(Number(state.cursor))) : 0,
      paused: Boolean(state.paused),
      completed: Boolean(state.completed),
      last_step_id: state.last_step_id ? cleanText(state.last_step_id, 120) : null,
      processed_step_ids: Array.isArray(state.processed_step_ids)
        ? state.processed_step_ids.map((row: unknown) => cleanText(row, 120)).filter(Boolean)
        : [],
      processed_events: Number.isFinite(Number(state.processed_events))
        ? Math.max(0, Math.floor(Number(state.processed_events)))
        : 0,
      digest: cleanText(state.digest, 128)
    },
    metadata: raw && raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    warnings: Array.isArray(raw && raw.warnings)
      ? raw.warnings.map((row: unknown) => cleanText(row, 220)).filter(Boolean)
      : []
  };
}

function failureReceipt(workflowId: string, reason: string) {
  const digest = stableHash([workflowId, reason, 'failed']);
  return {
    workflow_id: workflowId,
    status: 'failed',
    deterministic: true,
    replayable: false,
    processed_steps: 0,
    pause_reason: reason,
    event_digest: digest,
    events: [`error:${reason}`],
    state: {
      cursor: 0,
      paused: false,
      completed: false,
      last_step_id: null,
      processed_step_ids: [],
      processed_events: 0,
      digest
    },
    metadata: {},
    warnings: [reason]
  };
}

function runLegacyViaRust(input: unknown) {
  const out = runWorkflow(input, {
    prefer_wasm: true,
    allow_cli_fallback: true,
    security_gate_enabled: false
  });
  if (out && out.ok === true && out.payload && typeof out.payload === 'object') {
    return normalizeReceipt(out.payload);
  }
  return failureReceipt('invalid_workflow', `legacy_runtime_rust_bridge_failed:${cleanText(out && out.error, 180) || 'unknown'}`);
}

function runWorkflowLegacySpec(specRaw: AnyObj) {
  const payload = specRaw && typeof specRaw === 'object' ? specRaw : {};
  return runLegacyViaRust(payload);
}

function runWorkflowLegacyYaml(yaml: string) {
  return runLegacyViaRust(String(yaml || ''));
}

module.exports = {
  runWorkflowLegacySpec,
  runWorkflowLegacyYaml,
  stableHash
};

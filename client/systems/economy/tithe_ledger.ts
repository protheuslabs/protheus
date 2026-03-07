#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  appendJsonl,
  writeJsonAtomic,
  rel,
  stableHash,
  ROOT,
  cleanText
} = require('./_shared');
const { spawnSync } = require('child_process');

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function publishViaEventSourcedControlPlane(eventType: string, payload: Record<string, any>) {
  const cmd = [
    process.execPath,
    'systems/ops/event_sourced_control_plane.js',
    'append',
    '--stream=economy',
    `--event=${cleanEventType(eventType)}`,
    `--payload_json=${JSON.stringify(payload)}`
  ];
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 8000
  });
  const parsed = parseJsonFromStdout(proc.stdout);
  const ok = Number(proc.status || 0) === 0 && parsed && parsed.ok === true;
  return {
    ok,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    receipt: parsed && typeof parsed === 'object' ? parsed : null,
    stderr: cleanText(proc.stderr || '', 320)
  };
}

function appendLedger(policy: Record<string, any>, eventType: string, payload: Record<string, any>) {
  const eventPublish = publishViaEventSourcedControlPlane(eventType, payload);
  const row = {
    ts: nowIso(),
    type: cleanEventType(eventType),
    event_id: `econ_evt_${stableHash(`${eventType}|${JSON.stringify(payload)}|${Date.now()}`, 18)}`,
    payload,
    event_stream_publish: eventPublish.ok === true ? 'control_plane_append' : 'jsonl_fallback'
  };
  appendJsonl(policy.paths.ledger_path, row);
  if (!eventPublish.ok) {
    appendJsonl(policy.paths.event_stream_path, {
      ts: row.ts,
      event_id: row.event_id,
      stream: 'economy',
      event: row.type,
      payload: row.payload
    });
  }
  writeJsonAtomic(policy.paths.latest_path, {
    schema_id: 'compute_tithe_flywheel_latest',
    schema_version: '1.0',
    updated_at: nowIso(),
    latest_event: row,
    ledger_path: rel(policy.paths.ledger_path),
    event_stream_publish: eventPublish
  });
  appendJsonl(policy.paths.receipts_path, {
    schema_id: 'compute_tithe_flywheel_receipt',
    schema_version: '1.0',
    ts: row.ts,
    event_id: row.event_id,
    event: row.type,
    payload: row.payload,
    event_stream_publish: eventPublish
  });
  return row;
}

function cleanEventType(v: unknown) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'economy_event';
}

module.exports = {
  appendLedger
};

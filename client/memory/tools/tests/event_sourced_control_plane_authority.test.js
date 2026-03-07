#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-source-authority-'));
  const policyPath = path.join(tmp, 'config', 'event_sourced_control_plane_policy.json');
  const stateDir = path.join(tmp, 'state');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    authority: {
      source: 'local_authority',
      strict_reconcile: true,
      rollback_on_partition: true
    },
    jetstream: {
      enabled: false,
      shadow_only: true,
      allow_shadow_publish: false,
      subject_prefix: 'protheus.events',
      publish_command: [],
      timeout_ms: 5000
    },
    paths: {
      events_path: path.join(stateDir, 'events.jsonl'),
      stream_events_path: path.join(stateDir, 'stream_events.jsonl'),
      views_path: path.join(stateDir, 'views.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      jetstream_latest_path: path.join(stateDir, 'jetstream_latest.json'),
      authority_state_path: path.join(stateDir, 'authority_state.json'),
      reconcile_latest_path: path.join(stateDir, 'reconcile_latest.json'),
      rollback_latest_path: path.join(stateDir, 'rollback_latest.json')
    }
  });

  const env = { EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: policyPath };

  let out = run(['append', '--stream=control', '--event=mutation', '--payload_json={"x":1}'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'append 1 should pass');

  out = run(['append', '--stream=control', '--event=mutation', '--payload_json={"x":2}'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'append 2 should pass');

  out = run(['set-authority', '--source=stream_authority', '--apply=1', '--reason=test_cutover'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(String(out.payload.next_source || ''), 'stream_authority');

  out = run(['rebuild', '--source=stream_authority'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(Number(out.payload.event_count || 0), 2, 'stream authority should have 2 events');

  const streamEventsPath = path.join(stateDir, 'stream_events.jsonl');
  const rows = fs.readFileSync(streamEventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  fs.writeFileSync(streamEventsPath, `${JSON.stringify(rows[0])}\n`, 'utf8');

  out = run(['reconcile', '--partition=1', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === false, 'reconcile should detect mismatch');
  assert.ok(out.payload.rollback && out.payload.rollback.ok === true, 'partition mismatch should rollback authority');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(String(out.payload.authority_state.source || ''), 'local_authority', 'authority should rollback to local');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('event_sourced_control_plane_authority.test.js: OK');
} catch (err) {
  console.error(`event_sourced_control_plane_authority.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

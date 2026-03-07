#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'actuation', 'full_virtual_desktop_claw_lane.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    payload: parsePayload(r.stdout),
    stderr: String(r.stderr || '')
  };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-desktop-claw-test-'));
  const lanePolicy = path.join(tmp, 'lane_policy.json');
  const sessionPolicy = path.join(tmp, 'session_policy.json');
  writeJson(lanePolicy, {
    enabled: true,
    shadow_only: true,
    human_veto_window_sec: 90,
    receipts_path: path.join(tmp, 'state', 'lane', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'lane', 'latest.json')
  });
  writeJson(sessionPolicy, {
    enabled: true,
    shadow_only: true,
    high_risk_action_classes: ['shell'],
    require_explicit_approval_for_high_risk: true,
    allowed_opcodes: ['open', 'wait', 'capture'],
    receipts_path: path.join(tmp, 'state', 'session', 'receipts.jsonl'),
    sessions_path: path.join(tmp, 'state', 'session', 'sessions.json'),
    latest_path: path.join(tmp, 'state', 'session', 'latest.json')
  });

  const env = {
    FULL_VIRTUAL_DESKTOP_CLAW_POLICY_PATH: lanePolicy,
    INTERACTIVE_DESKTOP_SESSION_POLICY_PATH: sessionPolicy,
    PASSPORT_ITERATION_CHAIN_PATH: path.join(tmp, 'state', 'passport_chain.jsonl'),
    PASSPORT_ITERATION_CHAIN_LATEST_PATH: path.join(tmp, 'state', 'passport_chain.latest.json')
  };

  let r = run([
    'run',
    '--session-id=desktop_1',
    '--objective-id=obj_desktop',
    '--actions-json=[{"opcode":"open","target":"about:blank"},{"opcode":"wait","ms":50},{"opcode":"capture","name":"snap"}]',
    '--apply=0'
  ], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'lane run should succeed');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('full_virtual_desktop_claw_lane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`full_virtual_desktop_claw_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

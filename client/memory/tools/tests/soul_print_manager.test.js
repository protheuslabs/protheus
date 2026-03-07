#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'soul', 'soul_print_manager.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-print-manager-'));
  const policyPath = path.join(tmp, 'config', 'soul_policy.json');
  const stateRoot = path.join(tmp, 'state', 'security', 'soul_biometric');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    k_of_n_threshold: 2,
    min_confidence: 0.75,
    min_liveness_modalities: 2,
    modalities: {
      voice: { enabled: true, weight: 0.4, min_confidence: 0.7, mock_profile: 'stable' },
      typing_rhythm: { enabled: true, weight: 0.3, min_confidence: 0.7, mock_profile: 'stable' },
      gait_motion: { enabled: true, weight: 0.2, min_confidence: 0.6, mock_profile: 'stable' },
      os_biometric_attestation: { enabled: true, weight: 0.1, min_confidence: 0.8, mock_profile: 'stable' }
    },
    outputs: {
      state_root: stateRoot,
      latest_path: path.join(stateRoot, 'latest.json'),
      runtime_state_path: path.join(stateRoot, 'runtime_state.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      events_path: path.join(stateRoot, 'events.jsonl'),
      obsidian_path: path.join(stateRoot, 'obsidian_projection.jsonl'),
      emit_holo_events: true,
      emit_obsidian_receipts: true
    }
  });

  let proc = spawnSync(process.execPath, [script, 'run', `--policy=${policyPath}`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SOUL_SENSOR_PROFILE: 'stable'
    }
  });
  assert.strictEqual(proc.status, 0, proc.stderr || 'run should pass');
  let payload = parsePayload(proc.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.strictEqual(payload.shadow_only, true, 'shadow_only should stay true');
  assert.strictEqual(payload.match, true, 'stable profile should pass in mock mode');
  assert.ok(Number(payload.confidence || 0) >= 0.75, 'confidence should meet threshold');
  assert.ok(payload.commitment_id, 'commitment_id should exist');

  proc = spawnSync(process.execPath, [script, 'status', `--policy=${policyPath}`], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(proc.status, 0, proc.stderr || 'status should pass');
  payload = parsePayload(proc.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.strictEqual(payload.match, true, 'status should reflect latest match');
  assert.strictEqual(payload.shadow_only, true, 'status should remain shadow-only');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('soul_print_manager.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`soul_print_manager.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


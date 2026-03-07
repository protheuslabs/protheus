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

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseJsonOut(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout payload');
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse JSON output');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'inversion_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inversion-persona-lens-gate-'));
  const stateDir = path.join(tmp, 'state', 'autonomy', 'inversion');
  const policyPath = path.join(tmp, 'config', 'inversion_policy.json');
  const parityPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'parity_confidence.json');
  const receiptsPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'lens_gate_receipts.jsonl');
  const feedPushReceiptsPath = path.join(tmp, 'state', 'autonomy', 'inversion', 'lens_gate_feed_push_receipts.jsonl');
  const personaRoot = path.join(tmp, 'personas');
  fs.mkdirSync(personaRoot, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'personas', 'vikram_menon'), path.join(personaRoot, 'vikram_menon'), { recursive: true });

  writeJson(policyPath, {
    version: '1.0-lens-gate-test',
    enabled: true,
    shadow_mode: true,
    maturity_harness: {
      enabled: false,
      auto_trigger_on_run: false
    },
    persona_lens_gate: {
      enabled: true,
      persona_id: 'vikram_menon',
      mode: 'auto',
      require_parity_confidence: true,
      parity_confidence_min: 0.9,
      drift_threshold: 0.02,
      fail_closed_on_missing: false,
      feed_push: {
        enabled: true,
        min_drift: 0.01,
        include_shadow_mode: true,
        source: 'loop.inversion_controller',
        max_payload_len: 420
      },
      paths: {
        parity_confidence_path: parityPath,
        receipts_path: receiptsPath,
        feed_push_receipts_path: feedPushReceiptsPath,
        persona_feed_root: personaRoot
      }
    }
  });

  const env = {
    ...process.env,
    INVERSION_STATE_DIR: stateDir
  };

  writeJson(parityPath, { confidence: 0.95 });
  let proc = runNode(
    scriptPath,
    [
      'run',
      '--objective=Belief drift guard check with parity confidence high',
      '--impact=medium',
      '--target=tactical',
      '--certainty=0.95',
      '--drift-rate=0.03',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(proc.status, 0, proc.stderr || 'first run should return JSON payload');
  let out = parseJsonOut(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.allowed, false, 'enforced mode should fail closed when drift > 2%');
  assert.ok(
    Array.isArray(out.reasons) && out.reasons.includes('persona_lens_gate_fail_closed_drift_threshold_exceeded'),
    JSON.stringify(out.reasons || [])
  );
  assert.ok(out.persona_lens_gate && out.persona_lens_gate.status === 'blocked', 'lens gate status should be blocked');
  assert.strictEqual(out.persona_lens_gate.effective_mode, 'enforce', 'parity confidence should promote auto mode to enforce');
  assert.strictEqual(out.persona_lens_gate.parity_confident, true, 'parity confidence should be above threshold');
  assert.ok(out.persona_lens_gate.feed_push && out.persona_lens_gate.feed_push.pushed === true, 'feed push should occur when enabled and drift threshold exceeded');
  assert.ok(fs.existsSync(receiptsPath), 'lens gate receipts should be emitted');
  const receiptLines = fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(receiptLines.length >= 1, 'expected at least one lens gate receipt');
  const latestReceipt = JSON.parse(receiptLines[receiptLines.length - 1]);
  assert.strictEqual(latestReceipt.fail_closed, true, 'receipt should reflect fail-closed decision');
  assert.ok(fs.existsSync(feedPushReceiptsPath), 'feed push receipts should be emitted');
  const feedPushRows = fs.readFileSync(feedPushReceiptsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(feedPushRows.some((row) => row.type === 'persona_lens_feed_push'), 'feed push receipt should include persona_lens_feed_push row');
  const feedBody = fs.readFileSync(path.join(personaRoot, 'vikram_menon', 'feed.md'), 'utf8');
  assert.ok(feedBody.includes('## System Passed'), 'feed body should contain system-passed section');
  assert.ok(feedBody.includes('loop.inversion_controller'), 'feed body should include inversion source marker');

  writeJson(parityPath, { confidence: 0.4 });
  proc = runNode(
    scriptPath,
    [
      'run',
      '--objective=Belief drift guard check with low parity confidence',
      '--impact=medium',
      '--target=tactical',
      '--certainty=0.95',
      '--drift-rate=0.03',
      `--policy=${policyPath}`
    ],
    env,
    repoRoot
  );
  assert.strictEqual(proc.status, 0, proc.stderr || 'second run should return JSON payload');
  out = parseJsonOut(proc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.allowed, true, 'auto mode should remain shadow when parity confidence is low');
  assert.ok(out.persona_lens_gate && out.persona_lens_gate.status === 'shadow_observe', 'status should remain shadow observe');
  assert.strictEqual(out.persona_lens_gate.effective_mode, 'shadow', 'effective mode should remain shadow');
  assert.strictEqual(out.persona_lens_gate.fail_closed, false, 'shadow mode should not fail closed');
  assert.ok(
    Array.isArray(out.reasons) && !out.reasons.includes('persona_lens_gate_fail_closed_drift_threshold_exceeded'),
    'shadow mode should not inject fail-closed reason'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('inversion_persona_lens_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_persona_lens_gate.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}

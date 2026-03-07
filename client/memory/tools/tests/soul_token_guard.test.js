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
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'soul_token_guard.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-token-guard-'));
  const policyPath = path.join(tmp, 'config', 'soul_token_guard_policy.json');
  const soulPolicyPath = path.join(tmp, 'config', 'soul_policy.json');
  const soulStateRoot = path.join(tmp, 'state', 'security', 'soul_biometric');
  const tokenStatePath = path.join(tmp, 'state', 'security', 'soul_token_guard.json');
  const auditPath = path.join(tmp, 'state', 'security', 'soul_token_guard_audit.jsonl');
  const attestationPath = path.join(tmp, 'state', 'security', 'release_attestations.jsonl');
  const blackBoxDir = path.join(tmp, 'state', 'security', 'black_box_ledger', 'attestations');
  const key = 'test_soul_token_guard_key';

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    enforcement_mode: 'enforced',
    bind_to_fingerprint: true,
    key_env: 'SOUL_TOKEN_GUARD_KEY',
    token_state_path: tokenStatePath,
    audit_path: auditPath,
    attestation_path: attestationPath,
    black_box_attestation_dir: blackBoxDir,
    default_attestation_valid_hours: 24,
    biometric_attestation: {
      enabled: true,
      shadow_only: true,
      require_for_verify: false,
      min_confidence: 0.75,
      min_live_modalities: 2,
      timeout_ms: 8000,
      script: path.join(root, 'systems', 'soul', 'soul_print_manager.js'),
      policy_path: soulPolicyPath
    }
  });

  writeJson(soulPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    min_confidence: 0.75,
    k_of_n_threshold: 2,
    min_liveness_modalities: 2,
    modalities: {
      voice: { enabled: true, weight: 0.4, min_confidence: 0.7, mock_profile: 'stable' },
      typing_rhythm: { enabled: true, weight: 0.3, min_confidence: 0.7, mock_profile: 'stable' },
      gait_motion: { enabled: true, weight: 0.2, min_confidence: 0.6, mock_profile: 'stable' },
      os_biometric_attestation: { enabled: true, weight: 0.1, min_confidence: 0.8, mock_profile: 'stable' }
    },
    outputs: {
      state_root: soulStateRoot,
      latest_path: path.join(soulStateRoot, 'latest.json'),
      runtime_state_path: path.join(soulStateRoot, 'runtime_state.json'),
      receipts_path: path.join(soulStateRoot, 'receipts.jsonl'),
      events_path: path.join(soulStateRoot, 'events.jsonl'),
      obsidian_path: path.join(soulStateRoot, 'obsidian_projection.jsonl')
    }
  });

  const baseEnv = {
    ...process.env,
    SOUL_TOKEN_GUARD_POLICY_PATH: policyPath,
    SOUL_TOKEN_GUARD_KEY: key,
    SOUL_TOKEN_GUARD_FINGERPRINT: 'fp_test_primary'
  };

  const missingNote = spawnSync(process.execPath, [script, 'issue'], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.notStrictEqual(missingNote.status, 0, 'issue without approval note should fail');

  const issueRun = spawnSync(process.execPath, [
    script,
    'issue',
    '--instance-id=inst_test',
    '--approval-note=approved soul token issue for test'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(issueRun.status, 0, issueRun.stderr || 'issue command should pass');
  const issuePayload = parsePayload(issueRun.stdout);
  assert.ok(issuePayload && issuePayload.ok === true, 'issue payload should be ok');

  const stampRun = spawnSync(process.execPath, [
    script,
    'stamp-build',
    '--build-id=build-test-001',
    '--channel=test',
    '--valid-hours=24'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(stampRun.status, 0, stampRun.stderr || 'stamp-build should pass');
  const stampPayload = parsePayload(stampRun.stdout);
  assert.ok(stampPayload && stampPayload.ok === true, 'stamp-build payload should be ok');

  const verifyRun = spawnSync(process.execPath, [script, 'verify', '--strict=1'], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(verifyRun.status, 0, verifyRun.stderr || 'verify strict should pass after issue+stamp');
  const verifyPayload = parsePayload(verifyRun.stdout);
  assert.ok(verifyPayload && verifyPayload.ok === true, 'verify payload should be ok');
  assert.strictEqual(verifyPayload.shadow_only, false, 'verified token should not be shadow-only');
  assert.ok(
    verifyPayload.biometric_attestation && verifyPayload.biometric_attestation.checked === true,
    'biometric attestation should be evaluated'
  );

  const rows = readJsonl(attestationPath);
  assert.ok(rows.length >= 1, 'attestation rows should exist');
  const latest = rows[rows.length - 1];
  latest.signature = 'tampered_signature';
  rows[rows.length - 1] = latest;
  writeJsonl(attestationPath, rows);

  const tamperRun = spawnSync(process.execPath, [script, 'verify', '--strict=1'], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(tamperRun.status, 1, 'tampered attestation should fail strict verify');
  const tamperPayload = parsePayload(tamperRun.stdout);
  assert.ok(tamperPayload && tamperPayload.shadow_only === true, 'tampered attestation should force shadow');
  assert.strictEqual(String(tamperPayload.reason || ''), 'attestation_signature_invalid', 'tamper reason should be signature invalid');

  const restampRun = spawnSync(process.execPath, [
    script,
    'stamp-build',
    '--build-id=build-test-002',
    '--channel=test',
    '--valid-hours=24'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv
  });
  assert.strictEqual(restampRun.status, 0, restampRun.stderr || 'restamp should pass');

  const fpMismatchRun = spawnSync(process.execPath, [script, 'verify', '--strict=1'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      SOUL_TOKEN_GUARD_FINGERPRINT: 'fp_other_machine'
    }
  });
  assert.strictEqual(fpMismatchRun.status, 1, 'fingerprint mismatch should fail strict verify');
  const fpMismatchPayload = parsePayload(fpMismatchRun.stdout);
  assert.ok(fpMismatchPayload && fpMismatchPayload.shadow_only === true, 'fingerprint mismatch should force shadow');
  assert.strictEqual(String(fpMismatchPayload.reason || ''), 'token_fingerprint_mismatch', 'fingerprint mismatch reason should be token mismatch');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('soul_token_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`soul_token_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

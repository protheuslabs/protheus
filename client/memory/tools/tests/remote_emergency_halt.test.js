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

function runCli(script, args, root, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'security', 'remote_emergency_halt.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-halt-test-'));
  const policyPath = path.join(tmp, 'config', 'remote_emergency_halt_policy.json');
  const policyRootStub = path.join(tmp, 'tools', 'policy_root_stub.js');
  const leaseStatePath = path.join(tmp, 'state', 'security', 'capability_leases.json');
  const leaseAuditPath = path.join(tmp, 'state', 'security', 'capability_leases.jsonl');
  const sensitiveFile = path.join(tmp, 'state', 'security', 'sensitive.json');

  fs.mkdirSync(path.dirname(policyRootStub), { recursive: true });
  fs.writeFileSync(policyRootStub, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const cmd = String(process.argv[2] || "");',
    'if (cmd !== "authorize") { process.stdout.write(JSON.stringify({ ok: false, reason: "unsupported" }) + "\\n"); process.exit(1); }',
    'process.stdout.write(JSON.stringify({ ok: true, decision: "ALLOW", reason: "stub_allow" }) + "\\n");'
  ].join('\n'), 'utf8');

  writeJson(leaseStatePath, {
    version: '1.0',
    issued: {
      lease_a: { id: 'lease_a', scope: 'workflow_external_orchestration' },
      lease_b: { id: 'lease_b', scope: 'workflow_external_orchestration' }
    },
    consumed: {}
  });
  fs.mkdirSync(path.dirname(sensitiveFile), { recursive: true });
  fs.writeFileSync(sensitiveFile, '{"secret":true}\n', 'utf8');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    key_env: 'REMOTE_EMERGENCY_HALT_KEY',
    max_ttl_seconds: 300,
    max_clock_skew_seconds: 30,
    replay_nonce_ttl_seconds: 86400,
    paths: {
      state: path.join(tmp, 'state', 'security', 'remote_emergency_halt_state.json'),
      nonce_store: path.join(tmp, 'state', 'security', 'remote_emergency_halt_nonces.json'),
      audit: path.join(tmp, 'state', 'security', 'remote_emergency_halt_audit.jsonl'),
      black_box_attestation_dir: path.join(tmp, 'state', 'security', 'black_box_ledger', 'attestations')
    },
    policy_root: {
      enabled: true,
      script: policyRootStub,
      scope: 'workflow_external_orchestration',
      source: 'remote_emergency_halt_test',
      timeout_ms: 5000,
      require_lease_token: false
    },
    revoke_leases: {
      enabled: true,
      lease_state_path: leaseStatePath,
      lease_audit_path: leaseAuditPath
    },
    secure_purge: {
      enabled: true,
      allow_live_purge: true,
      window_minutes_default: 15,
      window_minutes_max: 60,
      confirm_phrase: 'I UNDERSTAND THIS PURGES SENSITIVE STATE',
      quarantine_dir: path.join(tmp, 'research', 'security', 'remote_halt_purge'),
      sensitive_paths: [sensitiveFile]
    }
  });

  const stopPath = path.join(root, 'state', 'security', 'emergency_stop.json');
  const stopBackupPath = `${stopPath}.remote-halt-test-backup-${Date.now()}`;
  const hadStop = fs.existsSync(stopPath);
  if (hadStop) {
    fs.mkdirSync(path.dirname(stopBackupPath), { recursive: true });
    fs.copyFileSync(stopPath, stopBackupPath);
  }

  const env = {
    ...process.env,
    REMOTE_EMERGENCY_HALT_POLICY_PATH: policyPath,
    REMOTE_EMERGENCY_HALT_KEY: 'remote_halt_test_key'
  };

  try {
    const signHalt = runCli(script, [
      'sign-halt',
      '--scope=all',
      '--approval-note=remote halt test approval note',
      '--reason=test_halt',
      '--ttl-sec=120',
      '--revoke-leases=1'
    ], root, env);
    assert.strictEqual(signHalt.status, 0, signHalt.stderr || 'sign-halt should pass');
    const signHaltPayload = parsePayload(signHalt.stdout);
    assert.ok(signHaltPayload && signHaltPayload.ok === true, 'sign-halt payload should be ok');
    assert.ok(signHaltPayload.command_b64, 'sign-halt should return command_b64');

    const receiveHalt = runCli(script, [
      'receive-b64',
      `--command-b64=${signHaltPayload.command_b64}`
    ], root, env);
    assert.strictEqual(receiveHalt.status, 0, receiveHalt.stderr || 'receive halt should pass');
    const receiveHaltPayload = parsePayload(receiveHalt.stdout);
    assert.ok(receiveHaltPayload && receiveHaltPayload.accepted === true, 'halt receive should be accepted');
    assert.ok(receiveHaltPayload.emergency_stop && receiveHaltPayload.emergency_stop.engaged === true, 'emergency stop should be engaged');
    assert.strictEqual(Number(receiveHaltPayload.leases.revoked_count || 0), 2, 'all active leases should be revoked');

    const replayHalt = runCli(script, [
      'receive-b64',
      `--command-b64=${signHaltPayload.command_b64}`
    ], root, env);
    assert.strictEqual(replayHalt.status, 1, 'replay command should be rejected');
    const replayPayload = parsePayload(replayHalt.stdout);
    assert.ok(replayPayload && replayPayload.reason === 'replay_nonce', 'replay rejection should be nonce-based');

    const signHaltPurge = runCli(script, [
      'sign-halt',
      '--scope=all',
      '--approval-note=remote halt with purge request',
      '--reason=test_halt_with_purge',
      '--ttl-sec=120',
      '--secure-purge=1',
      '--window-minutes=10',
      '--approval-a=approver_A',
      '--approval-b=approver_B',
      '--human-confirmation=I UNDERSTAND THIS PURGES SENSITIVE STATE'
    ], root, env);
    assert.strictEqual(signHaltPurge.status, 0, signHaltPurge.stderr || 'sign-halt with secure purge should pass');
    const signHaltPurgePayload = parsePayload(signHaltPurge.stdout);
    assert.ok(signHaltPurgePayload && signHaltPurgePayload.command_b64, 'signed purge-halt should return command blob');

    const receiveHaltPurge = runCli(script, [
      'receive-b64',
      `--command-b64=${signHaltPurgePayload.command_b64}`
    ], root, env);
    assert.strictEqual(receiveHaltPurge.status, 0, receiveHaltPurge.stderr || 'receive halt with purge should pass');
    const receiveHaltPurgePayload = parsePayload(receiveHaltPurge.stdout);
    assert.ok(receiveHaltPurgePayload && receiveHaltPurgePayload.accepted === true, 'halt+purge command should be accepted');
    assert.ok(receiveHaltPurgePayload.secure_purge && receiveHaltPurgePayload.secure_purge.pending === true, 'secure purge window should be opened');
    const pendingId = String(receiveHaltPurgePayload.secure_purge.pending_id || '');
    assert.ok(pendingId, 'pending purge id should be returned');

    const signPurge = runCli(script, [
      'sign-purge',
      `--pending-id=${pendingId}`,
      '--approval-note=remote purge commit approval note',
      '--ttl-sec=120',
      '--approval-a=approver_A',
      '--approval-b=approver_B',
      '--human-confirmation=I UNDERSTAND THIS PURGES SENSITIVE STATE'
    ], root, env);
    assert.strictEqual(signPurge.status, 0, signPurge.stderr || 'sign-purge should pass');
    const signPurgePayload = parsePayload(signPurge.stdout);
    assert.ok(signPurgePayload && signPurgePayload.command_b64, 'sign-purge should return command blob');

    const receivePurge = runCli(script, [
      'receive-b64',
      `--command-b64=${signPurgePayload.command_b64}`
    ], root, env);
    assert.strictEqual(receivePurge.status, 0, receivePurge.stderr || 'receive purge should pass');
    const receivePurgePayload = parsePayload(receivePurge.stdout);
    assert.ok(receivePurgePayload && receivePurgePayload.accepted === true, 'purge receive should be accepted');
    assert.ok(receivePurgePayload.secure_purge && receivePurgePayload.secure_purge.ok === true, 'purge should succeed');
    assert.strictEqual(receivePurgePayload.secure_purge.live_purge, true, 'purge should be live in this test policy');
    assert.strictEqual(Number(receivePurgePayload.secure_purge.moved_count || 0), 1, 'one sensitive file should be moved');
    assert.strictEqual(fs.existsSync(sensitiveFile), false, 'sensitive file should be moved out of source path');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('remote_emergency_halt.test.js: OK');
  } finally {
    if (hadStop) {
      fs.copyFileSync(stopBackupPath, stopPath);
      fs.rmSync(stopBackupPath, { force: true });
    } else {
      fs.rmSync(stopPath, { force: true });
    }
  }
}

try {
  run();
} catch (err) {
  console.error(`remote_emergency_halt.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

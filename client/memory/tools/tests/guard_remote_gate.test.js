#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampGuardEnv } = require('../../../lib/request_envelope.js');

function runGuard(repoRoot, env, filesArg, sign = false, signOptions = {}) {
  const guardPath = path.join(repoRoot, 'systems', 'security', 'guard.js');
  const files = String(filesArg || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
  const finalEnv = {
    ...process.env,
    KERNEL_INTEGRITY_ENFORCE: '0',
    ...env
  };
  const stamped = sign
    ? stampGuardEnv(finalEnv, {
        source: finalEnv.REQUEST_SOURCE || 'local',
        action: finalEnv.REQUEST_ACTION || 'apply',
        files,
        ts: signOptions.ts,
        nonce: signOptions.nonce,
        kid: signOptions.kid || finalEnv.REQUEST_KEY_ID
      })
    : finalEnv;
  const r = spawnSync('node', [guardPath, `--files=${filesArg}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: stamped
  });
  const line = String(r.stdout || '').split('\n').find((x) => x.trim().startsWith('{')) || '{}';
  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    payload = null;
  }
  return { status: r.status, payload, stderr: String(r.stderr || '') };
}

function assertBlockedRemote(r, expectedReason) {
  assert.strictEqual(r.status, 1, `expected blocked status=1, got ${r.status}`);
  assert.ok(r.payload && r.payload.ok === false, 'expected ok=false payload');
  assert.strictEqual(r.payload.reason, expectedReason, `expected reason=${expectedReason}`);
  assert.ok(r.payload.remote_policy && r.payload.remote_policy.is_remote === true, 'expected remote policy context');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const guardFiles = 'state/security/remote_request_gate.jsonl';
  const secret = 'remote-gate-test-secret';
  const replayPath = path.join(os.tmpdir(), `guard-replay-${process.pid}.json`);
  const riskyToggleApprovalPath = path.join(os.tmpdir(), `guard-risky-toggle-${process.pid}.json`);

  try {
    fs.unlinkSync(replayPath);
  } catch {}
  try {
    fs.unlinkSync(riskyToggleApprovalPath);
  } catch {}

  const blockedLocalRiskyToggle = runGuard(repoRoot, {
    CLEARANCE: '4',
    REQUEST_SOURCE: 'local',
    REQUEST_ACTION: 'apply',
    AUTONOMY_ENABLED: '1',
    REQUEST_RISKY_TOGGLE_APPROVAL_STATE_PATH: riskyToggleApprovalPath
  }, guardFiles);
  assert.strictEqual(blockedLocalRiskyToggle.status, 1, 'local risky toggle without approval should block');
  assert.strictEqual(
    blockedLocalRiskyToggle.payload && blockedLocalRiskyToggle.payload.reason,
    'risky_env_toggle_requires_manual_approval'
  );
  assert.strictEqual(
    blockedLocalRiskyToggle.payload && blockedLocalRiskyToggle.payload.risky_toggle_policy
      && blockedLocalRiskyToggle.payload.risky_toggle_policy.reason,
    'manual_toggle_approval_missing'
  );

  const allowedLocalRiskyToggle = runGuard(repoRoot, {
    CLEARANCE: '4',
    REQUEST_SOURCE: 'local',
    REQUEST_ACTION: 'apply',
    AUTONOMY_ENABLED: '1',
    APPROVAL_NOTE: 'manual env_toggle AUTONOMY_ENABLED approved for supervised local run',
    REQUEST_RISKY_TOGGLE_APPROVAL_STATE_PATH: riskyToggleApprovalPath
  }, guardFiles);
  assert.strictEqual(allowedLocalRiskyToggle.status, 0, `local risky toggle with approval should pass: ${allowedLocalRiskyToggle.stderr}`);
  assert.ok(allowedLocalRiskyToggle.payload && allowedLocalRiskyToggle.payload.ok === true);
  assert.strictEqual(
    allowedLocalRiskyToggle.payload && allowedLocalRiskyToggle.payload.risky_toggle_policy
      && allowedLocalRiskyToggle.payload.risky_toggle_policy.reason,
    'manual_toggle_approval_present'
  );

  const allowedLocalRiskyToggleCached = runGuard(repoRoot, {
    CLEARANCE: '4',
    REQUEST_SOURCE: 'local',
    REQUEST_ACTION: 'apply',
    AUTONOMY_ENABLED: '1',
    REQUEST_RISKY_TOGGLE_APPROVAL_STATE_PATH: riskyToggleApprovalPath
  }, guardFiles);
  assert.strictEqual(
    allowedLocalRiskyToggleCached.status,
    0,
    `local risky toggle should reuse cached approval: ${allowedLocalRiskyToggleCached.stderr}`
  );
  assert.ok(allowedLocalRiskyToggleCached.payload && allowedLocalRiskyToggleCached.payload.ok === true);
  assert.strictEqual(
    allowedLocalRiskyToggleCached.payload && allowedLocalRiskyToggleCached.payload.risky_toggle_policy
      && allowedLocalRiskyToggleCached.payload.risky_toggle_policy.reason,
    'manual_toggle_approval_cached'
  );

  const blockedNoOverride = runGuard(repoRoot, {
    CLEARANCE: '4',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles);
  assertBlockedRemote(blockedNoOverride, 'remote_direct_apply_disallowed');
  assert.ok((blockedNoOverride.payload.remote_policy.missing || []).includes('remote_direct_override'));

  const proposalAllowed = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'propose',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles);
  assert.strictEqual(proposalAllowed.status, 0, `proposal action should pass: ${proposalAllowed.stderr}`);
  assert.ok(proposalAllowed.payload && proposalAllowed.payload.ok === true, 'proposal action should return ok=true');

  const blockedMissingSecond = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REMOTE_DIRECT_OVERRIDE: '1',
    BREAK_GLASS: '1',
    APPROVER_ID: 'jay',
    APPROVAL_NOTE: 'approved for urgent hotfix with oversight',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles, true);
  assertBlockedRemote(blockedMissingSecond, 'remote_direct_apply_disallowed');
  assert.ok((blockedMissingSecond.payload.remote_policy.missing || []).includes('second_approval_note'));
  assert.ok((blockedMissingSecond.payload.remote_policy.missing || []).includes('second_approver_id'));

  const blockedMissingSignature = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REMOTE_DIRECT_OVERRIDE: '1',
    BREAK_GLASS: '1',
    APPROVER_ID: 'jay',
    APPROVAL_NOTE: 'approved for emergency supervised change',
    SECOND_APPROVER_ID: 'ops',
    SECOND_APPROVAL_NOTE: 'second approver confirms supervised execution',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles, false);
  assertBlockedRemote(blockedMissingSignature, 'remote_direct_apply_disallowed');
  assert.ok((blockedMissingSignature.payload.remote_policy.missing || []).includes('request_signature'));

  const allowedDirect = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REMOTE_DIRECT_OVERRIDE: '1',
    BREAK_GLASS: '1',
    APPROVER_ID: 'jay',
    APPROVAL_NOTE: 'approved for emergency supervised change',
    SECOND_APPROVER_ID: 'ops',
    SECOND_APPROVAL_NOTE: 'second approver confirms supervised execution',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles, true, { nonce: 'nonce-replay-guard-1' });
  assert.strictEqual(allowedDirect.status, 0, `direct apply with full approvals should pass: ${allowedDirect.stderr}`);
  assert.ok(allowedDirect.payload && allowedDirect.payload.ok === true, 'direct apply with full approvals should return ok=true');
  assert.ok(allowedDirect.payload.remote_policy && allowedDirect.payload.remote_policy.reason === 'remote_direct_apply_allowed');
  assert.strictEqual(allowedDirect.payload.remote_policy.signature_valid, true);

  const blockedReplay = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REMOTE_DIRECT_OVERRIDE: '1',
    BREAK_GLASS: '1',
    APPROVER_ID: 'jay',
    APPROVAL_NOTE: 'approved for emergency supervised change',
    SECOND_APPROVER_ID: 'ops',
    SECOND_APPROVAL_NOTE: 'second approver confirms supervised execution',
    REQUEST_GATE_SECRET: secret,
    REQUEST_REPLAY_STATE_PATH: replayPath
  }, guardFiles, true, { nonce: 'nonce-replay-guard-1' });
  assertBlockedRemote(blockedReplay, 'remote_direct_apply_disallowed');
  assert.ok((blockedReplay.payload.remote_policy.missing || []).includes('request_nonce_replay'));

  try {
    fs.unlinkSync(replayPath);
  } catch {}
  try {
    fs.unlinkSync(riskyToggleApprovalPath);
  } catch {}

  console.log('guard_remote_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`guard_remote_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

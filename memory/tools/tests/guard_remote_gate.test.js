#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampGuardEnv } = require('../../../lib/request_envelope.js');

function runGuard(repoRoot, env, filesArg, sign = false) {
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
        files
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

  const blockedNoOverride = runGuard(repoRoot, {
    CLEARANCE: '4',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'apply',
    REQUEST_GATE_SECRET: secret
  }, guardFiles);
  assertBlockedRemote(blockedNoOverride, 'remote_direct_apply_disallowed');
  assert.ok((blockedNoOverride.payload.remote_policy.missing || []).includes('remote_direct_override'));

  const proposalAllowed = runGuard(repoRoot, {
    CLEARANCE: '1',
    REQUEST_SOURCE: 'slack',
    REQUEST_ACTION: 'propose',
    REQUEST_GATE_SECRET: secret
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
    REQUEST_GATE_SECRET: secret
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
    REQUEST_GATE_SECRET: secret
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
    REQUEST_GATE_SECRET: secret
  }, guardFiles, true);
  assert.strictEqual(allowedDirect.status, 0, `direct apply with full approvals should pass: ${allowedDirect.stderr}`);
  assert.ok(allowedDirect.payload && allowedDirect.payload.ok === true, 'direct apply with full approvals should return ok=true');
  assert.ok(allowedDirect.payload.remote_policy && allowedDirect.payload.remote_policy.reason === 'remote_direct_apply_allowed');
  assert.strictEqual(allowedDirect.payload.remote_policy.signature_valid, true);

  console.log('guard_remote_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`guard_remote_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'environment_promotion_gate.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    try { payload = JSON.parse(out); } catch {}
  }
  if (!payload) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-promotion-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const logPath = path.join(tmp, 'promotions.jsonl');
  const statePath = path.join(tmp, 'promotion_state.json');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    environment_order: ['dev', 'stage', 'prod'],
    ownership: {
      dev: ['platform'],
      stage: ['platform', 'qa'],
      prod: ['platform', 'security']
    },
    dual_control_envs: ['prod'],
    min_approval_note_len: 8,
    required_checks_by_env: {
      stage: ['contract_check'],
      prod: ['contract_check', 'ci_suite']
    }
  });

  const env = {
    ENV_PROMOTION_POLICY_PATH: policyPath,
    ENV_PROMOTION_LOG_PATH: logPath,
    ENV_PROMOTION_STATE_PATH: statePath
  };

  try {
    let r = run([
      'promote',
      '--from=dev',
      '--to=stage',
      '--owner=platform',
      '--artifact=sha123',
      '--checks=contract_check',
      '--approval-note=approved move to stage'
    ], env);
    assert.strictEqual(r.status, 0, `stage promotion should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'stage promotion should allow');

    r = run([
      'promote',
      '--from=stage',
      '--to=prod',
      '--owner=platform',
      '--artifact=sha123',
      '--checks=contract_check,ci_suite',
      '--approver-id=alice',
      '--second-approver-id=bob',
      '--approval-note=approved prod release',
      '--second-approval-note=second approval release'
    ], env);
    assert.strictEqual(r.status, 0, `prod promotion should pass with dual control: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'prod promotion should allow');

    r = run([
      'promote',
      '--from=stage',
      '--to=prod',
      '--owner=platform',
      '--artifact=sha124',
      '--checks=contract_check',
      '--approver-id=alice',
      '--approval-note=approved prod release',
      '--second-approver-id=alice',
      '--second-approval-note=duplicate approver should fail'
    ], env);
    assert.notStrictEqual(r.status, 0, 'prod promotion should fail strict when dual control invalid');
    assert.ok(r.payload && r.payload.ok === false, 'expected deny payload');
    assert.ok(Array.isArray(r.payload.reasons) && r.payload.reasons.includes('dual_approvers_must_differ'));

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.recent_decisions || 0) >= 3, 'status should include promotion history');

    console.log('environment_promotion_gate.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`environment_promotion_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

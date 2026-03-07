#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function parseJson(out) {
  const lines = String(out || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function runNode(cwd, args) {
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: process.env
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'security', 'model_vaccine_sandbox.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-vaccine-'));

  const policyPath = path.join(tmp, 'model_vaccine_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    state_dir: path.join(tmp, 'state'),
    max_high_findings: 1,
    max_critical_findings: 0,
    require_sandbox_snapshot: true,
    min_approval_note_chars: 4
  });

  const failed = runNode(repoRoot, [
    scriptPath,
    'onboard',
    '--model-id=test/model_fail',
    '--provider=local',
    '--critical-findings=1',
    '--high-findings=0',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(failed.status, 0, failed.stderr || 'failed onboarding should return payload');
  const failedPayload = parseJson(failed.stdout);
  assert.strictEqual(failedPayload.pass, false);

  const blockedPromote = runNode(repoRoot, [
    scriptPath,
    'promote',
    '--model-id=test/model_fail',
    '--approver-id=owner_a',
    '--approval-note=try promote fail model',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(blockedPromote.status, 1, 'failed vaccine model should not promote');

  const passed = runNode(repoRoot, [
    scriptPath,
    'onboard',
    '--model-id=test/model_pass',
    '--provider=local',
    '--critical-findings=0',
    '--high-findings=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(passed.status, 0, passed.stderr || 'passed onboarding should return payload');
  const passedPayload = parseJson(passed.stdout);
  assert.strictEqual(passedPayload.pass, true);

  const promote = runNode(repoRoot, [
    scriptPath,
    'promote',
    '--model-id=test/model_pass',
    '--approver-id=owner_a',
    '--approval-note=promote after vaccine pass',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(promote.status, 0, promote.stderr || 'passed model should promote');
  const promotePayload = parseJson(promote.stdout);
  assert.strictEqual(promotePayload.status, 'promoted');

  console.log('model_vaccine_sandbox.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`model_vaccine_sandbox.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}

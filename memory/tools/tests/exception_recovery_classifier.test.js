#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'exception_recovery_classifier.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return String(fs.readFileSync(filePath, 'utf8') || '').split('\n').filter(Boolean).length;
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exception-recovery-'));
  const policyPath = path.join(tmp, 'config', 'exception_recovery_classifier_policy.json');
  const recoveryPolicyPath = path.join(tmp, 'config', 'autonomy_exception_recovery_policy.json');
  const memoryPath = path.join(tmp, 'state', 'autonomy', 'exception_classifier', 'memory.json');
  const telemetryPath = path.join(tmp, 'state', 'autonomy', 'exception_classifier', 'telemetry.jsonl');
  const escalationPath = path.join(tmp, 'state', 'autonomy', 'human_escalation_queue.jsonl');

  writeJson(recoveryPolicyPath, {
    version: '1.0-test',
    novel: { action: 'escalate', cooldown_hours: 12, playbook: 'novel_exception_escalation' },
    known_default: { action: 'recover', cooldown_hours: 2, playbook: 'retry_with_backoff' },
    code_overrides: {
      rate_limited: { action: 'cooldown', cooldown_hours: 8, playbook: 'respect_rate_limit' }
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    recovery_policy_path: recoveryPolicyPath,
    memory_path: memoryPath,
    telemetry_path: telemetryPath,
    escalation_path: escalationPath,
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'exception_classifier', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'exception_classifier', 'history.jsonl')
    }
  });

  const env = {
    EXCEPTION_CLASSIFIER_ROOT: tmp,
    EXCEPTION_CLASSIFIER_POLICY_PATH: policyPath
  };

  let r = run([
    'record',
    '--stage=proposal_fetch',
    '--error-code=rate_limited',
    '--error-message=HTTP 429 from upstream API'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || 'first record should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'first payload should be ok');
  assert.strictEqual(out.tracked.novel, true, 'first signature should be novel');
  assert.strictEqual(out.recovery.action, 'escalate', 'novel exception should escalate per policy');
  assert.ok(countJsonl(escalationPath) >= 1, 'novel escalation should be emitted');

  r = run([
    'record',
    '--stage=proposal_fetch',
    '--error-code=rate_limited',
    '--error-message=HTTP 429 from upstream API'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || 'repeat record should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'repeat payload should be ok');
  assert.strictEqual(out.tracked.novel, false, 'repeat signature should not be novel');
  assert.strictEqual(out.recovery.action, 'cooldown', 'known code override should use cooldown action');
  assert.strictEqual(out.recovery.playbook, 'respect_rate_limit');
  assert.ok(countJsonl(telemetryPath) >= 4, 'classifier should emit both novelty + recovery telemetry rows');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'status should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.summary && Number(out.summary.signature_count || 0) === 1, 'status should report one signature');

  console.log('exception_recovery_classifier.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`exception_recovery_classifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

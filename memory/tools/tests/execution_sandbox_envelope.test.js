#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'execution_sandbox_envelope.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-envelope-'));
  const policyPath = path.join(tmp, 'config', 'execution_sandbox_envelope_policy.json');
  const latestPath = path.join(tmp, 'state', 'security', 'execution_sandbox_envelope', 'latest.json');
  const auditPath = path.join(tmp, 'state', 'security', 'execution_sandbox_envelope', 'audit.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    mode: 'enforce',
    default_host_fs_access: false,
    default_network_access: false,
    profiles: {
      workflow_container_strict: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:bounded']
      },
      actuation_container_strict: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:adapter_only']
      },
      simulation_sandbox: {
        runtime: 'container',
        isolation: ['seccomp', 'apparmor'],
        host_fs_access: false,
        network_access: false,
        capability_manifest: ['exec:simulation_only']
      }
    },
    workflow_profile_map: {
      command: 'workflow_container_strict',
      receipt: 'simulation_sandbox'
    },
    actuation_profile: 'actuation_container_strict',
    blocked_command_tokens: ['sudo', '--privileged', 'docker run'],
    high_risk_actuation_classes: ['shell'],
    require_approval_for_high_risk_actuation: true,
    paths: {
      latest_path: latestPath,
      audit_path: auditPath
    }
  });

  const env = { EXECUTION_SANDBOX_ENVELOPE_POLICY_PATH: policyPath };

  let r = run(['evaluate-workflow', '--step-id=s1', '--step-type=command', '--command=node scripts/task.js'], env);
  assert.strictEqual(r.status, 0, `safe workflow should pass: ${r.stderr || r.stdout}`);
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === true, 'safe workflow should be allowed');
  assert.strictEqual(payload.profile_id, 'workflow_container_strict');

  r = run(['evaluate-workflow', '--step-id=escape', '--step-type=command', '--command=sudo docker run --privileged ubuntu'], env);
  assert.notStrictEqual(r.status, 0, 'escape attempt should be denied');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === false, 'escape workflow must be denied');

  r = run(['evaluate-actuation', '--kind=browser_automation', '--context={"risk_class":"shell"}'], env);
  assert.notStrictEqual(r.status, 0, 'high risk actuation without approval should fail');
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === false, 'high risk actuation denied without approval');

  r = run(['evaluate-actuation', '--kind=browser_automation', '--context={"risk_class":"shell","sandbox_approval":true}'], env);
  assert.strictEqual(r.status, 0, `high risk actuation with approval should pass: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.allowed === true, 'approved high risk actuation should pass');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.latest, 'status should include latest audit row');

  console.log('execution_sandbox_envelope.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`execution_sandbox_envelope.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

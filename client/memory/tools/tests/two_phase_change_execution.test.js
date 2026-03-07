#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'two_phase_change_execution.js');

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
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-phase-change-'));
  const policyPath = path.join(tmp, 'config', 'two_phase_change_execution_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    auto_rollback_default: true,
    verify_required_steps: ['tests', 'contracts'],
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'history.jsonl'),
      phase_receipts_path: path.join(tmp, 'state', 'autonomy', 'phase_receipts')
    }
  });

  const env = {
    TWO_PHASE_CHANGE_EXECUTION_ROOT: tmp,
    TWO_PHASE_CHANGE_EXECUTION_POLICY_PATH: policyPath
  };

  let r = run([
    'run',
    '--change-id=chg-pass',
    '--plan-json={"steps":["patch","verify"]}',
    '--verify-json={"tests":true,"contracts":true}',
    '--strict=1'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || 'pass flow should succeed');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'pass payload should be ok');
  assert.strictEqual(out.rollback_executed, false, 'no rollback expected on success');

  r = run([
    'run',
    '--change-id=chg-fail',
    '--plan-json={"steps":["patch","verify"]}',
    '--verify-json={"tests":false,"contracts":true}',
    '--strict=1'
  ], env);
  assert.notStrictEqual(r.status, 0, 'verify failure should fail strict mode');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'fail payload should be false');
  assert.strictEqual(out.rollback_executed, true, 'rollback should execute on verify failure');
  assert.strictEqual(out.root_cause, 'verify_phase_failed', 'root cause should be verify failure');

  console.log('two_phase_change_execution.test.js: OK');
}

try { main(); } catch (err) { console.error(`two_phase_change_execution.test.js: FAIL: ${err.message}`); process.exit(1); }

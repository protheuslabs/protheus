#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'chaos_program.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-program-test-'));
  const policyPath = path.join(tmp, 'chaos_policy.json');
  const receiptsPath = path.join(tmp, 'chaos_receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    integrity_command: 'node -e "process.exit(0)"',
    scenarios: [
      {
        id: 'pass_case',
        lane: 'routing',
        fault: 'sim_pass',
        recovery_command: 'node -e "process.exit(0)"',
        timeout_ms: 10000
      },
      {
        id: 'fail_case',
        lane: 'sensory',
        fault: 'sim_fail',
        recovery_command: 'node -e "process.exit(2)"',
        timeout_ms: 10000
      }
    ]
  });

  const env = {
    CHAOS_PROGRAM_POLICY_PATH: policyPath,
    CHAOS_PROGRAM_RECEIPTS_PATH: receiptsPath
  };

  try {
    let r = run(['run', '--scenario=pass_case', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `pass scenario should pass strict: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'pass scenario payload should be ok');
    assert.strictEqual(Number(r.payload.failed_count || 0), 0);

    r = run(['run', '--scenario=fail_case', '--strict=1'], env);
    assert.notStrictEqual(r.status, 0, 'failing scenario should fail strict mode');
    assert.ok(r.payload && r.payload.ok === false, 'failing scenario payload should fail');

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'status payload should be ok');
    assert.ok(Number(r.payload.recent_runs || 0) >= 2, 'status should observe recorded runs');

    console.log('chaos_program.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`chaos_program.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

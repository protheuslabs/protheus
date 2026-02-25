#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'postmortem_loop.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(filePath, body) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  let payload = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      payload = JSON.parse(lines[i]);
      break;
    } catch {}
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmortem-loop-test-'));
  const policyPath = path.join(tmp, 'postmortem_policy.json');
  const postmortemDir = path.join(tmp, 'state', 'ops', 'postmortems');
  const receipts = path.join(tmp, 'state', 'ops', 'postmortem_receipts.jsonl');

  writeText(policyPath, JSON.stringify({
    version: '1.0',
    postmortem_dir: path.relative(ROOT, postmortemDir),
    receipts_path: path.relative(ROOT, receipts),
    require_preventive_check_ref: true,
    require_preventive_verification_pass: true
  }, null, 2));

  const env = { POSTMORTEM_POLICY_PATH: policyPath };

  try {
    let r = run(['open', '--incident-id=INC-42', '--severity=sev1', '--owner=ops', '--summary=drift spike'], env);
    assert.strictEqual(r.status, 0, `open should succeed: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'open response should be ok');

    r = run(['add-action', '--incident-id=INC-42', '--type=corrective', '--description=repair classifier', '--owner=jay'], env);
    assert.strictEqual(r.status, 0, `add corrective should succeed: ${r.stderr}`);
    assert.strictEqual(String(r.payload.action_id || ''), 'A1');

    r = run([
      'add-action',
      '--incident-id=INC-42',
      '--type=preventive',
      '--description=add regression test',
      '--owner=jay',
      '--check-ref=memory/tools/tests/dr_gameday_gate.test.js'
    ], env);
    assert.strictEqual(r.status, 0, `add preventive should succeed: ${r.stderr}`);
    assert.strictEqual(String(r.payload.action_id || ''), 'A2');

    r = run(['resolve-action', '--incident-id=INC-42', '--action-id=A1', '--resolution=patched'], env);
    assert.strictEqual(r.status, 0, `resolve corrective should succeed: ${r.stderr}`);

    r = run(['resolve-action', '--incident-id=INC-42', '--action-id=A2', '--resolution=ready'], env);
    assert.notStrictEqual(r.status, 0, 'preventive resolve should fail before verification');

    r = run(['verify-action', '--incident-id=INC-42', '--action-id=A2', '--pass=1', '--evidence=test linked'], env);
    assert.strictEqual(r.status, 0, `verify preventive should succeed: ${r.stderr}`);

    r = run(['resolve-action', '--incident-id=INC-42', '--action-id=A2', '--resolution=guard added'], env);
    assert.strictEqual(r.status, 0, `resolve preventive should now succeed: ${r.stderr}`);

    r = run(['status', '--incident-id=INC-42'], env);
    assert.strictEqual(r.status, 0, 'status should succeed');
    assert.ok(r.payload && r.payload.close_guard && r.payload.close_guard.closable === true, 'incident should be closable');

    r = run(['close', '--incident-id=INC-42', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `close should succeed: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'close should pass');

    r = run(['list', '--status=closed', '--limit=5'], env);
    assert.strictEqual(r.status, 0, 'list should succeed');
    assert.ok(Array.isArray(r.payload.rows) && r.payload.rows.length === 1, 'closed incident should be listed');

    console.log('postmortem_loop.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`postmortem_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

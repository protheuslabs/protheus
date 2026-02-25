#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'capability_switchboard.js');

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
  return {
    status: Number(r.status || 0),
    stdout: out,
    stderr: String(r.stderr || '').trim(),
    payload
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-switch-test-'));
  const policyPath = path.join(tmp, 'capability_switchboard_policy.json');
  const statePath = path.join(tmp, 'state', 'capability_switchboard_state.json');
  const auditPath = path.join(tmp, 'state', 'capability_switchboard_audit.jsonl');
  const policyRootMock = path.join(tmp, 'policy_root_mock.js');

  writeJson(policyPath, {
    version: '1.0',
    require_dual_control: true,
    dual_control_min_note_len: 8,
    policy_root: {
      required: true,
      scope: 'capability_switchboard_toggle'
    },
    switches: {
      autonomy: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true
      },
      security: {
        default_enabled: true,
        security_locked: true,
        require_policy_root: true
      }
    }
  });

  fs.writeFileSync(policyRootMock, [
    "#!/usr/bin/env node",
    "'use strict';",
    "process.stdout.write(JSON.stringify({ ok: true, decision: 'ALLOW', lease_id: 'lease_mock_1' }));"
  ].join('\n') + '\n', 'utf8');

  const env = {
    CAPABILITY_SWITCHBOARD_POLICY_PATH: policyPath,
    CAPABILITY_SWITCHBOARD_STATE_PATH: statePath,
    CAPABILITY_SWITCHBOARD_AUDIT_PATH: auditPath,
    CAPABILITY_SWITCHBOARD_POLICY_ROOT_SCRIPT: policyRootMock
  };

  try {
    let r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'status payload missing');
    const autonomy = (r.payload.switches || []).find((s) => s.id === 'autonomy');
    assert.ok(autonomy && autonomy.enabled === true, 'autonomy default should be enabled');

    r = run([
      'set',
      '--switch=autonomy',
      '--state=off',
      '--approver-id=alice',
      '--approval-note=disable autonomy during incident',
      '--second-approver-id=bob',
      '--second-approval-note=confirmed disable during containment'
    ], env);
    assert.strictEqual(r.status, 0, `autonomy off should pass: ${r.stderr} ${r.stdout}`);
    assert.ok(r.payload && r.payload.ok === true, 'autonomy off payload should be ok');
    assert.strictEqual(r.payload.enabled, false, 'autonomy should be disabled');

    r = run(['evaluate', '--switch=autonomy'], env);
    assert.strictEqual(r.status, 0, `evaluate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.enabled === false, 'evaluate should reflect disabled switch');

    r = run([
      'set',
      '--switch=security',
      '--state=off',
      '--approver-id=alice',
      '--approval-note=attempt disable security should fail',
      '--second-approver-id=bob',
      '--second-approval-note=attempt disable security should fail'
    ], env);
    assert.notStrictEqual(r.status, 0, 'security disable should fail');
    assert.ok(r.payload && r.payload.reason === 'security_locked_non_deactivatable', 'expected security lock reason');

    r = run([
      'set',
      '--switch=autonomy',
      '--state=on',
      '--approver-id=alice',
      '--approval-note=short',
      '--second-approver-id=bob',
      '--second-approval-note=short'
    ], env);
    assert.notStrictEqual(r.status, 0, 'too-short notes should fail');
    assert.ok(r.payload && String(r.payload.reason || '').includes('approval_note_too_short'), 'expected note length gate');

    console.log('capability_switchboard.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`capability_switchboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

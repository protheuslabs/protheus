#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'dr_gameday.js');

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
  let payload = null;
  if (out) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: r.status, stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-gameday-test-'));
  const receipts = path.join(tmp, 'dr_gameday_receipts.jsonl');
  const policyPath = path.join(tmp, 'dr_policy.json');
  const backupStub = path.join(tmp, 'state_backup_stub.js');
  const integrityStub = path.join(tmp, 'backup_integrity_stub.js');

  writeText(policyPath, JSON.stringify({
    version: '1.0',
    default_channel: 'state_backup',
    default_profile: 'runtime_state',
    rto_target_minutes: 30,
    rpo_target_hours: 24,
    strict_default: true
  }, null, 2));

  writeText(backupStub, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const cmd = argv[0] || '';
if (cmd === 'run') {
  process.stdout.write(JSON.stringify({
    ok: true,
    profile: 'runtime_state',
    snapshot_id: '20260223T120000Z'
  }) + '\\n');
  process.exit(0);
}
if (cmd === 'list') {
  process.stdout.write(JSON.stringify({
    ok: true,
    profile: 'runtime_state',
    snapshots: [{ snapshot_id: '20260223T120000Z', ts: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString() }]
  }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: false, error: 'unsupported_cmd' }) + '\\n');
process.exit(1);
`);

  writeText(integrityStub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  ok: true,
  type: 'backup_integrity_check',
  failed_channels: 0
}) + '\\n');
`);

  const env = {
    DR_GAMEDAY_POLICY_PATH: policyPath,
    DR_GAMEDAY_RECEIPTS_PATH: receipts,
    DR_GAMEDAY_STATE_BACKUP_SCRIPT: backupStub,
    DR_GAMEDAY_BACKUP_INTEGRITY_SCRIPT: integrityStub
  };

  try {
    let r = run(['run', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'run payload should pass gates');
    assert.strictEqual(String(r.payload.type || ''), 'dr_gameday');
    assert.ok(Number(r.payload.metrics && r.payload.metrics.rto_minutes || 999) < 30, 'rto should be under target');
    assert.ok(Number(r.payload.metrics && r.payload.metrics.rpo_hours || 999) < 24, 'rpo should be under target');

    r = run(['list', '--limit=1'], env);
    assert.strictEqual(r.status, 0, `list should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'list payload should pass');
    assert.ok(Array.isArray(r.payload.rows) && r.payload.rows.length === 1, 'list should return one receipt');

    console.log('dr_gameday.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`dr_gameday.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


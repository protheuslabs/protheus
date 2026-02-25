#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'anti_sabotage_shield.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(p, body) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, body, 'utf8');
}

function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + '\n');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-sabotage-test-'));
  const fakeRoot = path.join(tmp, 'repo');
  const policyPath = path.join(tmp, 'policy.json');

  const fooPath = path.join(fakeRoot, 'systems', 'security', 'foo.js');
  const cfgPath = path.join(fakeRoot, 'config', 'sample.json');
  writeText(fooPath, 'module.exports = 1;\n');
  writeJson(cfgPath, { ok: true });

  writeJson(policyPath, {
    version: '1.0',
    protected_roots: [
      path.relative(ROOT, path.join(fakeRoot, 'systems')),
      path.relative(ROOT, path.join(fakeRoot, 'config'))
    ],
    extensions: ['.js', '.json'],
    snapshots_dir: path.relative(ROOT, path.join(tmp, 'snapshots')),
    quarantine_dir: path.relative(ROOT, path.join(tmp, 'quarantine')),
    incident_log: path.relative(ROOT, path.join(tmp, 'incidents.jsonl')),
    state_file: path.relative(ROOT, path.join(tmp, 'state.json')),
    auto_reset_default: true,
    verify_strict_default: true
  });

  const env = {
    ANTI_SABOTAGE_POLICY_PATH: policyPath
  };

  try {
    let r = run(['snapshot', '--label=baseline'], env);
    assert.strictEqual(r.status, 0, `snapshot should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.snapshot_id, 'snapshot id missing');

    writeText(fooPath, 'module.exports = 999;\n');

    r = run(['verify', '--strict=0', '--auto-reset=0'], env);
    assert.strictEqual(r.status, 0, `non-strict verify should return 0: ${r.stderr}`);
    assert.ok(r.payload && r.payload.violated === true, 'verify should detect violation');
    assert.ok(Number(r.payload.mismatch_count || 0) >= 1, 'mismatch should be present');

    r = run(['verify', '--strict=1', '--auto-reset=1'], env);
    assert.strictEqual(r.status, 0, `auto-reset verify should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.violated === true, 'violation should still be reported');
    assert.ok(r.payload.recovery && Array.isArray(r.payload.recovery.restored), 'recovery payload missing');
    const restoredContent = fs.readFileSync(fooPath, 'utf8');
    assert.ok(restoredContent.includes('module.exports = 1;'), 'file should be restored to snapshot content');

    console.log('anti_sabotage_shield.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`anti_sabotage_shield.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

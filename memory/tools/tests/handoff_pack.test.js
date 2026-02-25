#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'handoff_pack.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-pack-test-'));
  const policyPath = path.join(tmp, 'handoff_policy.json');
  const packDir = path.join(tmp, 'state', 'ops', 'handoff_pack');
  const receipts = path.join(tmp, 'state', 'ops', 'handoff_sim_receipts.jsonl');

  const fakeDoc = path.join(tmp, 'docs', 'REQ.md');
  writeText(fakeDoc, '# required\n');

  writeText(policyPath, JSON.stringify({
    version: '1.0',
    pack_dir: path.relative(ROOT, packDir),
    receipts_path: path.relative(ROOT, receipts),
    sla_target_minutes: 5,
    required_docs: [path.relative(ROOT, fakeDoc)],
    critical_commands: ['node -e "process.exit(0)"'],
    ownership_matrix: [
      { path_prefix: 'systems/spine/', primary_owner: 'jay', secondary_owner: 'ops', service_level: 'critical' },
      { path_prefix: 'systems/security/', primary_owner: 'jay', secondary_owner: 'ops', service_level: 'critical' }
    ]
  }, null, 2));

  const env = { HANDOFF_POLICY_PATH: policyPath };

  try {
    let r = run(['build', '2026-02-25'], env);
    assert.strictEqual(r.status, 0, `build should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'build should be ok');

    r = run(['simulate', '2026-02-25', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `simulate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'simulation should pass');
    assert.strictEqual(r.payload.gates.commands_pass, true, 'commands gate should pass');

    r = run(['list', '--limit=5'], env);
    assert.strictEqual(r.status, 0, 'list should pass');
    assert.ok(Array.isArray(r.payload.rows) && r.payload.rows.length >= 1, 'list should include simulation receipt');

    console.log('handoff_pack.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`handoff_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

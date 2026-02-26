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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-sabotage-watch-test-'));
  const fakeRoot = path.join(tmp, 'repo');
  const policyPath = path.join(tmp, 'policy.json');

  const fooPath = path.join(fakeRoot, 'systems', 'security', 'foo.js');
  writeText(fooPath, 'module.exports = 1;\n');

  writeJson(policyPath, {
    version: '1.0',
    protected_roots: [
      path.relative(ROOT, path.join(fakeRoot, 'systems'))
    ],
    extensions: ['.js'],
    snapshots_dir: path.relative(ROOT, path.join(tmp, 'snapshots')),
    quarantine_dir: path.relative(ROOT, path.join(tmp, 'quarantine')),
    incident_log: path.relative(ROOT, path.join(tmp, 'incidents.jsonl')),
    state_file: path.relative(ROOT, path.join(tmp, 'state.json')),
    watcher_state_file: path.relative(ROOT, path.join(tmp, 'watcher_state.json')),
    auto_reset_default: true,
    verify_strict_default: true,
    watcher_interval_ms: 1,
    watcher_auto_reset_default: true,
    watcher_strict_default: true
  });

  const env = {
    ANTI_SABOTAGE_POLICY_PATH: policyPath
  };

  try {
    let r = run(['snapshot', '--label=baseline'], env);
    assert.strictEqual(r.status, 0, `snapshot should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.snapshot_id, 'snapshot id missing');

    writeText(fooPath, 'module.exports = 777;\n');

    r = run(['watch', '--iterations=1', '--interval-ms=1', '--auto-reset=1', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `watch should pass with auto-reset: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'watch payload should report ok');
    assert.strictEqual(Number(r.payload.iterations || 0), 1, 'watch should run exactly one iteration');
    assert.ok(Number(r.payload.violations || 0) >= 1, 'watch should record violation');
    assert.ok(Number(r.payload.recoveries || 0) >= 1, 'watch should record recovery');

    const restored = fs.readFileSync(fooPath, 'utf8');
    assert.ok(restored.includes('module.exports = 1;'), 'watch should restore mutated file');

    const watcherStatePath = path.join(tmp, 'watcher_state.json');
    assert.ok(fs.existsSync(watcherStatePath), 'watcher state file should be written');
    const watcherState = JSON.parse(fs.readFileSync(watcherStatePath, 'utf8'));
    assert.strictEqual(Number(watcherState.iterations || 0), 1, 'watcher state iterations should match');

    console.log('anti_sabotage_shield_watch.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`anti_sabotage_shield_watch.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


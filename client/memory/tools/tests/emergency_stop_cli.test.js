#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function runCli(repoRoot, args) {
  const script = path.join(repoRoot, 'systems', 'security', 'emergency_stop.js');
  return spawnSync('node', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const stopPath = path.join(repoRoot, 'state', 'security', 'emergency_stop.json');
  const backupPath = `${stopPath}.cli-test-backup-${Date.now()}`;
  const hadExisting = fs.existsSync(stopPath);
  if (hadExisting) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(stopPath, backupPath);
  }

  try {
    // approval note is required for engage/release.
    let r = runCli(repoRoot, ['engage', '--scope=autonomy']);
    assert.notStrictEqual(r.status, 0, 'engage without approval note should fail');

    r = runCli(repoRoot, ['engage', '--scope=autonomy', '--approval-note=cli drill engage approval']);
    assert.strictEqual(r.status, 0, `engage should pass: ${r.stderr}`);
    let out = parseJson(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.result, 'engaged');
    assert.ok(out.state && out.state.engaged === true, 'state should be engaged');
    assert.ok(Array.isArray(out.state.scopes) && out.state.scopes.includes('autonomy'), 'scope should include autonomy');

    r = runCli(repoRoot, ['status']);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    out = parseJson(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.ok(out.state && out.state.engaged === true, 'status should report engaged');

    r = runCli(repoRoot, ['release', '--approval-note=cli drill release approval']);
    assert.strictEqual(r.status, 0, `release should pass: ${r.stderr}`);
    out = parseJson(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.result, 'released');
    assert.ok(out.state && out.state.engaged === false, 'state should be released');

    r = runCli(repoRoot, ['status']);
    assert.strictEqual(r.status, 0, `status after release should pass: ${r.stderr}`);
    out = parseJson(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.ok(out.state && out.state.engaged === false, 'status should report released');

    console.log('emergency_stop_cli.test.js: OK');
  } finally {
    if (hadExisting) {
      fs.copyFileSync(backupPath, stopPath);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.rmSync(stopPath, { force: true });
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`emergency_stop_cli.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

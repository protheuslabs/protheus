#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const em = require('../../../lib/emergency_stop.js');

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const stopPath = path.join(repoRoot, 'state', 'security', 'emergency_stop.json');
  const backupPath = `${stopPath}.test-backup-${Date.now()}`;
  const hadExisting = fs.existsSync(stopPath);
  if (hadExisting) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(stopPath, backupPath);
  }

  try {
    em.engageEmergencyStop({
      scopes: 'routing',
      approval_note: 'route_task emergency-stop behavior test',
      actor: 'test',
      reason: 'unit_test'
    });

    const script = path.join(repoRoot, 'systems', 'routing', 'route_task.js');
    const r = spawnSync('node', [
      script,
      '--task', 'test route decision under emergency stop',
      '--tokens_est', '0',
      '--repeats_14d', '0',
      '--errors_30d', '0'
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.strictEqual(r.status, 0, `route_task should exit 0 when stop engaged: ${r.stderr}`);
    const out = parseJson(r.stdout);
    assert.strictEqual(out.decision, 'MANUAL');
    assert.strictEqual(out.gate_decision, 'DENY');
    assert.ok(String(out.reason || '').includes('emergency stop'));
    assert.ok(out.emergency_stop && out.emergency_stop.engaged === true);

    console.log('route_task_emergency_stop.test.js: OK');
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
  run();
} catch (err) {
  console.error(`route_task_emergency_stop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

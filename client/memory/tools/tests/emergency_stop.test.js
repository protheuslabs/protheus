#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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
    const em = require('../../../lib/emergency_stop.js');

    em.releaseEmergencyStop({
      approval_note: 'test reset state before assertions',
      actor: 'test',
      reason: 'unit_test_reset'
    });
    let st = em.getStopState();
    assert.strictEqual(st.engaged, false);

    const engaged = em.engageEmergencyStop({
      scopes: 'autonomy,routing',
      approval_note: 'test engage emergency stop',
      actor: 'test',
      reason: 'unit_test_engage'
    });
    assert.strictEqual(engaged.engaged, true);
    assert.ok(Array.isArray(engaged.scopes));
    assert.ok(engaged.scopes.includes('autonomy'));
    assert.ok(engaged.scopes.includes('routing'));

    const hitAuto = em.isEmergencyStopEngaged('autonomy');
    const missActuation = em.isEmergencyStopEngaged('actuation');
    assert.strictEqual(hitAuto.engaged, true);
    assert.strictEqual(missActuation.engaged, false);

    em.releaseEmergencyStop({
      approval_note: 'test release emergency stop',
      actor: 'test',
      reason: 'unit_test_release'
    });
    st = em.getStopState();
    assert.strictEqual(st.engaged, false);

    console.log('emergency_stop.test.js: OK');
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
  console.error(`emergency_stop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

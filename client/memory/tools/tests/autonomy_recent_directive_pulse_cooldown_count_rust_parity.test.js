#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const dateStr = new Date().toISOString().slice(0, 10);
  const tsProfile = ts.loadDirectivePulseObjectives();
  const sampleObjective = tsProfile
    && Array.isArray(tsProfile.objectives)
    && tsProfile.objectives[0]
    && tsProfile.objectives[0].id
    ? String(tsProfile.objectives[0].id)
    : 'NO_OBJECTIVE';

  const tsKnown = Number(ts.recentDirectivePulseCooldownCount(dateStr, sampleObjective, 48));
  const rustKnown = Number(rust.recentDirectivePulseCooldownCount(dateStr, sampleObjective, 48));
  assert.strictEqual(rustKnown, tsKnown, 'recentDirectivePulseCooldownCount known objective mismatch');

  const tsUnknown = Number(ts.recentDirectivePulseCooldownCount(dateStr, 'OBJECTIVE_NOT_PRESENT', 48));
  const rustUnknown = Number(rust.recentDirectivePulseCooldownCount(dateStr, 'OBJECTIVE_NOT_PRESENT', 48));
  assert.strictEqual(rustUnknown, tsUnknown, 'recentDirectivePulseCooldownCount unknown objective mismatch');

  console.log('autonomy_recent_directive_pulse_cooldown_count_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_recent_directive_pulse_cooldown_count_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

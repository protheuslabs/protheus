#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'hold_remediation_engine.js');
const POLICY_PATH = path.join(ROOT, 'config', 'hold_remediation_engine_policy.json');
const STATE_DIR = path.join(ROOT, 'state', 'autonomy', 'hold_remediation_engine');

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
}

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOLD_REMEDIATION_ENGINE_POLICY_PATH: POLICY_PATH
    }
  });
}

function exitCode(res) {
  return Number.isFinite(Number(res && res.status)) ? Number(res.status) : 1;
}

function fail(msg) {
  console.error(`❌ hold_remediation_engine.test.js: ${msg}`);
  process.exit(1);
}

function rmState() {
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
}

function main() {
  rmState();

  const p1 = {
    id: 'hold_test_a',
    title: 'Repeatable topic',
    kind: 'generic',
    confidence: 0.66,
    estimated_tokens: 800,
    payload: { topic: 'revenue' },
    route: { mode: 'auto' }
  };

  const first = run(['admit', `--proposal-json=${JSON.stringify(p1)}`, '--apply=1', '--strict=1']);
  if (exitCode(first) !== 0) fail(`admit#1 failed: ${String(first.stderr || '').slice(0, 300)}`);
  const firstOut = parseJson(first.stdout);
  if (!firstOut || firstOut.ok !== true) fail('admit#1 payload invalid');
  if (!['execute', 'canary_execute', 'score_only_fallback_low_execution_confidence'].includes(String(firstOut.decision || ''))) {
    fail(`admit#1 unexpected decision: ${String(firstOut.decision || '')}`);
  }

  const second = run(['admit', `--proposal-json=${JSON.stringify(p1)}`, '--apply=1', '--strict=1']);
  if (exitCode(second) !== 0) fail(`admit#2 failed: ${String(second.stderr || '').slice(0, 300)}`);
  const secondOut = parseJson(second.stdout);
  if (!secondOut || secondOut.ok !== true) fail('admit#2 payload invalid');
  if (String(secondOut.decision || '') !== 'parked_unchanged_state') {
    fail(`expected unchanged-state hold, got: ${String(secondOut.decision || '')}`);
  }

  const manual = {
    id: 'hold_test_manual',
    title: 'Manual-only op',
    kind: 'manual_only',
    confidence: 0.91,
    estimated_tokens: 700,
    payload: { topic: 'secure-op' },
    route: { mode: 'manual' }
  };
  const manualRes = run(['admit', `--proposal-json=${JSON.stringify(manual)}`, '--apply=1', '--strict=1']);
  if (exitCode(manualRes) !== 0) fail(`manual admit failed: ${String(manualRes.stderr || '').slice(0, 300)}`);
  const manualOut = parseJson(manualRes.stdout);
  if (!manualOut || manualOut.ok !== true) fail('manual admit payload invalid');
  if (String(manualOut.decision || '') !== 'gate_manual') {
    fail(`expected gate_manual, got: ${String(manualOut.decision || '')}`);
  }

  for (let i = 0; i < 10; i += 1) {
    const burst = {
      id: `hold_burst_${i}`,
      title: `Burst ${i}`,
      kind: 'generic',
      confidence: 0.95,
      estimated_tokens: 2200,
      payload: { i },
      route: { mode: 'auto' }
    };
    const burstRes = run(['admit', `--proposal-json=${JSON.stringify(burst)}`, '--apply=1', '--strict=1']);
    if (exitCode(burstRes) !== 0) fail(`burst admit ${i} failed`);
  }

  const rehydrate = run(['rehydrate', '--apply=1', '--strict=1']);
  if (exitCode(rehydrate) !== 0) fail(`rehydrate failed: ${String(rehydrate.stderr || '').slice(0, 300)}`);
  const rehydrateOut = parseJson(rehydrate.stdout);
  if (!rehydrateOut || rehydrateOut.ok !== true) fail('rehydrate payload invalid');
  if (!Array.isArray(rehydrateOut.promoted_ids)) fail('rehydrate promoted_ids missing');

  const sim = run(['simulate', '--days=30', '--apply=1', '--strict=1']);
  if (exitCode(sim) !== 0) fail(`simulate failed: ${String(sim.stderr || '').slice(0, 300)}`);
  const simOut = parseJson(sim.stdout);
  if (!simOut || simOut.ok !== true) fail('simulate payload invalid');
  if (!simOut.metrics || !Number.isFinite(Number(simOut.metrics.hold_rate))) {
    fail('simulate metrics missing hold_rate');
  }

  const status = run(['status']);
  if (exitCode(status) !== 0) fail(`status failed: ${String(status.stderr || '').slice(0, 300)}`);
  const statusOut = parseJson(status.stdout);
  if (!statusOut || statusOut.ok !== true) fail('status payload invalid');
  if (!statusOut.state || typeof statusOut.state !== 'object') fail('status state missing');

  console.log('hold_remediation_engine.test.js: OK');
}

main();

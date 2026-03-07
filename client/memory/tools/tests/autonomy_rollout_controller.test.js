#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(repoRoot, 'memory', 'tools', 'tests', 'temp_rollout_controller');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const policyPath = path.join(tmpRoot, 'policy.json');
  const statePath = path.join(tmpRoot, 'state.json');
  const auditPath = path.join(tmpRoot, 'audit.jsonl');

  writeJson(policyPath, {
    version: 'test',
    shadow_min_days: 3,
    canary_min_days: 5,
    canary_live_fraction: 0.15,
    canary_force_low_risk: true,
    canary_frozen_daily_token_cap: 1234,
    canary_max_runs_per_day: 1,
    eval_every_hours: 12,
    harness_days: 30,
    gates: {
      max_effective_drift_rate: 0.05,
      min_effective_yield_rate: 0.5,
      max_effective_safety_stop_rate: 0.01
    }
  });

  writeJson(statePath, {
    version: '1.0',
    stage: 'shadow',
    stage_since: isoHoursAgo(24 * 8),
    last_evaluated_at: null,
    last_eval: null
  });

  const rollout = require('../../../systems/autonomy/autonomy_rollout_controller.js');

  const promote = rollout.evaluateRollout({
    policyPath,
    statePath,
    auditPath,
    endDate: '2026-02-23',
    days: 30,
    write: true,
    harness_payload: {
      checks_effective: {
        drift_rate: { value: 0.03 },
        yield_rate: { value: 0.67 },
        safety_stop_rate: { value: 0 }
      }
    }
  });
  assert.strictEqual(promote.ok, true);
  assert.strictEqual(promote.after.stage, 'canary', 'shadow should promote to canary when gates pass and min days met');

  const stateAfterPromote = readJson(statePath);
  assert.strictEqual(stateAfterPromote.stage, 'canary');

  let sampledLive = null;
  for (let i = 0; i < 48; i++) {
    const now = new Date(Date.now() + i * 60 * 60 * 1000).toISOString();
    const decision = rollout.decideAction('2026-02-23', stateAfterPromote, rollout.loadPolicy(policyPath), now);
    if (decision.sampled_live === true) {
      sampledLive = decision;
      break;
    }
  }
  assert.ok(sampledLive, 'canary decision should sample live at least once across 48 hourly buckets');
  assert.strictEqual(sampledLive.controller_cmd, 'run');
  assert.strictEqual(sampledLive.env.AUTONOMY_ALLOWED_RISKS, 'low');
  assert.strictEqual(sampledLive.env.AUTONOMY_DAILY_TOKEN_CAP, '1234');

  const setLive = rollout.setStage({
    policyPath,
    statePath,
    auditPath,
    stage: 'live',
    approval_note: 'promote for test'
  });
  assert.strictEqual(setLive.ok, true);

  const demote = rollout.evaluateRollout({
    policyPath,
    statePath,
    auditPath,
    endDate: '2026-02-23',
    days: 30,
    write: true,
    harness_payload: {
      checks_effective: {
        drift_rate: { value: 0.25 },
        yield_rate: { value: 0.3 },
        safety_stop_rate: { value: 0.1 }
      }
    }
  });
  assert.strictEqual(demote.ok, true);
  assert.strictEqual(demote.after.stage, 'canary', 'live should demote to canary when gates fail');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('autonomy_rollout_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_rollout_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

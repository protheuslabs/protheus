#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(root, 'systems', 'workflow', 'rate_limit_intelligence.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-intel-'));
  const policyPath = path.join(tmp, 'config', 'rate_limit_intelligence_policy.json');
  const statePath = path.join(tmp, 'state', 'rate_limit_state.json');
  const eventsPath = path.join(tmp, 'state', 'rate_limit_events.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    channels: {
      default: { hard_limit_per_hour: 20, min_interval_sec: 30, base_cooldown_sec: 120, max_cooldown_sec: 600 },
      upwork: { hard_limit_per_hour: 2, min_interval_sec: 30, base_cooldown_sec: 120, max_cooldown_sec: 600 }
    },
    high_trust_fast_path: {
      enabled: true,
      min_trust_score: 0.75,
      min_quality_score: 0.7,
      max_drift_risk: 0.3,
      max_interval_reduction: 0.4
    }
  });

  const baseInput = {
    adapter: 'upwork_message',
    provider: 'upwork_api',
    workflow_id: 'wf_rate_limit',
    objective_id: 'obj_rate_limit',
    quality_score: 0.9,
    drift_risk: 0.2,
    trust_score: 0.9,
    dry_run: false
  };
  const opts = { policyPath, statePath, eventsPath, apply: true };
  const t0 = 1760000000000;

  const first = mod.evaluateRateLimitDecision({
    ...baseInput,
    now_ms: t0
  }, opts);
  assert.strictEqual(first.ok, true, 'first send should pass');
  assert.strictEqual(first.decision, 'allow', 'first decision should allow');

  const second = mod.evaluateRateLimitDecision({
    ...baseInput,
    now_ms: t0 + (5 * 1000)
  }, opts);
  assert.strictEqual(second.ok, false, 'second send should defer due to interval');
  assert.ok(
    second.reason === 'adaptive_interval_guard' || second.reason === 'cooldown_active',
    `unexpected reason: ${second.reason}`
  );

  const outcome = mod.recordRateLimitOutcome({
    ...baseInput,
    ok: false,
    failure_reason: 'provider_429_rate_limit',
    now_ms: t0 + (6 * 1000)
  }, { policyPath, statePath, eventsPath });
  assert.strictEqual(outcome.ok, true, 'outcome should persist');
  assert.ok(outcome.cooldown_until, 'cooldown should be populated after 429');

  const third = mod.evaluateRateLimitDecision({
    ...baseInput,
    now_ms: t0 + (8 * 1000)
  }, opts);
  assert.strictEqual(third.ok, false, 'third send should stay deferred during cooldown');
  assert.strictEqual(third.reason, 'cooldown_active', 'cooldown should be enforced');

  const state = mod.loadState(statePath);
  const laneKeys = Object.keys(state.lanes || {});
  assert.ok(laneKeys.length >= 1, 'lane state should persist');
  const lane = state.lanes[laneKeys[0]];
  assert.ok(Number(lane.trust_ema || 1) < 0.9, 'trust ema should degrade after rate-limit failure');

  assert.ok(fs.existsSync(eventsPath), 'events should persist');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 3, 'decision/outcome events should be emitted');
}

run();

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const mod = require(path.join(ROOT, 'systems', 'autonomy', 'physiology_opportunity_map.js'));
const config = require(path.join(ROOT, 'config', 'autonomy_physiology_opportunities.json'));

function mockSimulation(payload = {}) {
  return {
    ok: true,
    type: 'autonomy_simulation_harness',
    end_date: '2026-02-23',
    days: 180,
    checks: {
      drift_rate: { value: 0.26 },
      yield_rate: { value: 0.44 },
      safety_stop_rate: { value: 0.02 },
      policy_hold_rate: { value: 0.31 }
    },
    checks_effective: {
      drift_rate: { value: 0.034 },
      yield_rate: { value: 0.66 },
      safety_stop_rate: { value: 0.0 },
      policy_hold_rate: { value: 0.41 }
    },
    counters: {
      attempts: 200,
      no_progress: 60
    },
    queue: {
      total: 150,
      pending: 45
    },
    objective_mix: {
      objective_count: 2
    },
    ...payload
  };
}

function testNormalizeSimulationMetrics() {
  const out = mod.normalizeSimulationMetrics(mockSimulation());
  assert.strictEqual(out.no_progress_rate_raw, 0.3);
  assert.strictEqual(Number(out.queue_pending_ratio.toFixed(3)), 0.3);
  assert.strictEqual(out.objective_concentration, 0.5);
  assert.strictEqual(out.effective_policy_hold_rate, 0.41);
}

function testGapSeverities() {
  const metrics = mod.normalizeSimulationMetrics(mockSimulation());
  const severities = mod.buildGapSeverities(metrics, config);
  assert.ok(severities.effective_policy_hold_rate.severity > 0.5, 'policy hold severity should be elevated');
  assert.ok(severities.effective_yield_rate.severity > 0, 'yield severity should be non-zero below target');
  assert.strictEqual(severities.effective_drift_rate.severity > 0, true, 'effective drift should be above warn threshold');
}

function testOpportunityScoring() {
  const metrics = mod.normalizeSimulationMetrics(mockSimulation());
  const severities = mod.buildGapSeverities(metrics, config);
  const scored = mod.computeOpportunityScores(config, severities);
  assert.ok(Array.isArray(scored) && scored.length >= 5, 'should score configured opportunities');
  assert.ok(scored[0].score >= scored[1].score, 'opportunities should be sorted by descending score');
  assert.ok(['P1', 'P2', 'P3'].includes(scored[0].priority), 'priority label should be assigned');
}

function testOutputContract() {
  const out = mod.buildOutput(
    mockSimulation(),
    '/tmp/sim.json',
    '/tmp/config.json',
    config,
    3
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.type, 'autonomy_physiology_opportunity_map');
  assert.strictEqual(Array.isArray(out.top_opportunities), true);
  assert.strictEqual(out.top_opportunities.length, 3);
  assert.ok(Array.isArray(out.policy.anti_gaming_contract));
}

function main() {
  testNormalizeSimulationMetrics();
  testGapSeverities();
  testOpportunityScoring();
  testOutputContract();
  console.log('physiology_opportunity_map.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`physiology_opportunity_map.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

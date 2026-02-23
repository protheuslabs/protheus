#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const gate = require(path.join(ROOT, 'systems', 'autonomy', 'lever_experiment_gate.js'));

function mkHarnessPayload({ drift, yieldRate, safety }) {
  return {
    ok: true,
    type: 'autonomy_simulation_harness',
    checks_effective: {
      drift_rate: { value: drift },
      yield_rate: { value: yieldRate },
      safety_stop_rate: { value: safety }
    }
  };
}

function testEvaluateGate() {
  const policy = {
    metric_scope: 'checks_effective',
    performance: {
      min_drift_reduction: 0.003,
      min_yield_increase: 0.02,
      max_drift_increase: 0.001,
      max_yield_drop: 0.01,
      max_safety_stop_increase: 0
    }
  };

  const baseline = mkHarnessPayload({ drift: 0.04, yieldRate: 0.61, safety: 0 });
  const perfWin = mkHarnessPayload({ drift: 0.036, yieldRate: 0.61, safety: 0 });
  const perfFlat = mkHarnessPayload({ drift: 0.0395, yieldRate: 0.612, safety: 0 });
  const perfRegressed = mkHarnessPayload({ drift: 0.045, yieldRate: 0.598, safety: 0.01 });

  const gateWin = gate.evaluateGate(baseline, perfWin, policy, { p1: false });
  assert.strictEqual(gateWin.ok, true, 'performance gate should pass when drift reduction clears threshold');
  assert.strictEqual(gateWin.checks.required_lift, true);

  const gateFlat = gate.evaluateGate(baseline, perfFlat, policy, { p1: false });
  assert.strictEqual(gateFlat.ok, false, 'performance gate should fail when lift is below thresholds');
  assert.ok(gateFlat.failures.includes('performance_lift_below_threshold'));

  const p1Flat = gate.evaluateGate(baseline, perfFlat, policy, { p1: true });
  assert.strictEqual(p1Flat.ok, true, 'p1 override should pass when non-regression is respected');

  const p1Regressed = gate.evaluateGate(baseline, perfRegressed, policy, { p1: true });
  assert.strictEqual(p1Regressed.ok, false, 'p1 override must fail if regression guard is violated');
  assert.ok(p1Regressed.failures.includes('drift_regressed_over_max'));
}

function testClassifyPaths() {
  const paths = [
    'state/autonomy/simulations/2026-02-23.json',
    'state/security/startup_attestation.json',
    'memory/.rebuild_delta_cache.json',
    'memory/MEMORY_INDEX.md',
    'systems/autonomy/lever_experiment_gate.js',
    'config/lever_experiment_policy.json'
  ];
  const churnExcludes = [
    'state/**',
    'memory/.rebuild_delta_cache.json',
    'memory/MEMORY_INDEX.md'
  ];
  const out = gate.classifyPaths(paths, churnExcludes);
  assert.strictEqual(out.counts.all, 6);
  assert.strictEqual(out.counts.churn, 4);
  assert.strictEqual(out.counts.code, 2);
  assert.ok(out.code.includes('systems/autonomy/lever_experiment_gate.js'));
  assert.ok(out.code.includes('config/lever_experiment_policy.json'));
}

function testParseGitStatusPaths() {
  const status = [
    ' M state/autonomy/simulations/2026-02-23.json',
    ' M systems/autonomy/lever_experiment_gate.js',
    'R  old/path.txt -> new/path.txt',
    '?? memory/MEMORY_INDEX.md'
  ].join('\n');
  const out = gate.parseGitStatusPaths(status);
  assert.deepStrictEqual(out, [
    'memory/MEMORY_INDEX.md',
    'new/path.txt',
    'state/autonomy/simulations/2026-02-23.json',
    'systems/autonomy/lever_experiment_gate.js'
  ]);
}

function main() {
  testEvaluateGate();
  testClassifyPaths();
  testParseGitStatusPaths();
  console.log('lever_experiment_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`lever_experiment_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

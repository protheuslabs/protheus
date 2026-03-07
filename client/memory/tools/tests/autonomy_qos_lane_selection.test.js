#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function makeCandidate(id, { type = 'external_intel', risk = 'low', tier = null, queueUnderflow = false } = {}) {
  const cand = {
    proposal: {
      id,
      type,
      risk
    },
    risk,
    queue_underflow_backfill: queueUnderflow === true
  };
  if (tier != null) {
    cand.directive_pulse = { tier: Number(tier) };
  }
  return cand;
}

function makeRuns(count, mode) {
  const out = [];
  for (let i = 0; i < Math.max(0, Number(count || 0)); i++) {
    out.push({
      type: 'autonomy_run',
      result: 'executed',
      selection_mode: mode
    });
  }
  return out;
}

function run() {
  assert.strictEqual(
    controller.qosLaneFromCandidate(makeCandidate('Q1', { queueUnderflow: true })),
    'quarantine',
    'queue-underflow backfill candidates should route to quarantine lane'
  );
  assert.strictEqual(
    controller.qosLaneFromCandidate(makeCandidate('Q2', { tier: 1 })),
    'critical',
    'tier-1 directive pulse should route to critical lane'
  );
  assert.strictEqual(
    controller.qosLaneFromCandidate(makeCandidate('Q3', { type: 'directive_clarification' })),
    'critical',
    'directive_clarification should route to critical lane'
  );
  assert.strictEqual(
    controller.qosLaneFromCandidate(makeCandidate('Q4', { risk: 'medium' })),
    'explore',
    'medium-risk candidates should route to explore lane'
  );
  assert.strictEqual(
    controller.qosLaneFromCandidate(makeCandidate('Q5', { risk: 'low' })),
    'standard',
    'default low-risk candidates should route to standard lane'
  );

  const critical = makeCandidate('SEL-CRIT', { tier: 1 });
  const standard = makeCandidate('SEL-STD', { risk: 'low' });
  const baseSelection = controller.chooseQosLaneSelection(
    [critical, standard],
    [],
    {
      shadowOnly: false,
      queuePressure: { pressure: 'normal', total: 10, pending: 1, pending_ratio: 0.1 }
    }
  );
  assert.ok(baseSelection && baseSelection.pick, 'expected QoS selection for normal pressure');
  assert.strictEqual(String(baseSelection.pick.proposal.id), 'SEL-CRIT', 'critical lane should be preferred over standard by default weights');
  assert.strictEqual(baseSelection.selection.qos_lane, 'critical', 'selection should surface chosen qos lane');
  assert.ok(
    String(baseSelection.selection.mode || '').startsWith('qos_critical_'),
    'selection mode should include qos lane prefix'
  );

  const standardOnly = makeCandidate('BP-STD', { risk: 'low' });
  const exploreOnly = makeCandidate('BP-EXP', { risk: 'medium' });
  const heavyStandardUsage = makeRuns(30, 'qos_standard_exploit');

  const normalBackpressureControl = controller.chooseQosLaneSelection(
    [standardOnly, exploreOnly],
    heavyStandardUsage,
    {
      shadowOnly: false,
      queuePressure: { pressure: 'normal', total: 100, pending: 20, pending_ratio: 0.2 }
    }
  );
  assert.ok(normalBackpressureControl && normalBackpressureControl.pick, 'expected normal-pressure control selection');
  assert.strictEqual(
    normalBackpressureControl.selection.qos_lane,
    'explore',
    'without backpressure, explore lane should win when standard lane is heavily used'
  );

  const criticalBackpressure = controller.chooseQosLaneSelection(
    [standardOnly, exploreOnly],
    heavyStandardUsage,
    {
      shadowOnly: false,
      queuePressure: { pressure: 'critical', total: 100, pending: 70, pending_ratio: 0.7 }
    }
  );
  assert.ok(criticalBackpressure && criticalBackpressure.pick, 'expected critical-pressure selection');
  assert.strictEqual(
    criticalBackpressure.selection.qos_lane,
    'standard',
    'critical pressure should block explore lane when core lanes are available'
  );
  assert.ok(
    Array.isArray(criticalBackpressure.telemetry && criticalBackpressure.telemetry.blocked_lanes)
      && criticalBackpressure.telemetry.blocked_lanes.includes('explore'),
    'critical pressure telemetry should report explore lane as blocked'
  );

  const cappedExploreRuns = [
    ...makeRuns(20, 'qos_explore_exploit'),
    ...makeRuns(35, 'qos_standard_exploit')
  ];
  const shareCapSelection = controller.chooseQosLaneSelection(
    [makeCandidate('CAP-STD', { risk: 'low' }), makeCandidate('CAP-EXP', { risk: 'medium' })],
    cappedExploreRuns,
    {
      shadowOnly: false,
      queuePressure: { pressure: 'normal', total: 80, pending: 12, pending_ratio: 0.15 }
    }
  );
  assert.ok(shareCapSelection && shareCapSelection.pick, 'expected share-cap selection');
  assert.strictEqual(
    shareCapSelection.selection.qos_lane,
    'standard',
    'explore lane should be suppressed when explore share cap is exceeded and core lanes are available'
  );

  const exploreOnlyUnderCritical = controller.chooseQosLaneSelection(
    [makeCandidate('SOLO-EXP', { risk: 'medium' })],
    makeRuns(5, 'qos_explore_exploit'),
    {
      shadowOnly: false,
      queuePressure: { pressure: 'critical', total: 20, pending: 15, pending_ratio: 0.75 }
    }
  );
  assert.ok(exploreOnlyUnderCritical && exploreOnlyUnderCritical.pick, 'expected selection when only explore lane is available');
  assert.strictEqual(
    exploreOnlyUnderCritical.selection.qos_lane,
    'explore',
    'critical pressure should not drop all candidates when no core lanes exist'
  );

  console.log('autonomy_qos_lane_selection.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_qos_lane_selection.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

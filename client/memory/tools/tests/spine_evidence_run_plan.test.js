#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { computeEvidenceRunPlan } = require(path.join(ROOT, 'systems', 'spine', 'evidence_run_plan.js'));

try {
  let out = computeEvidenceRunPlan(2, 'none', 'none');
  assert.strictEqual(out.configured_runs, 2);
  assert.strictEqual(out.pressure_throttle, false);
  assert.strictEqual(out.evidence_runs, 2);

  out = computeEvidenceRunPlan(3, 'soft', 'none');
  assert.strictEqual(out.pressure_throttle, true);
  assert.strictEqual(out.evidence_runs, 1, 'soft pressure should throttle to one evidence run');

  out = computeEvidenceRunPlan(4, 'none', 'hard');
  assert.strictEqual(out.pressure_throttle, true);
  assert.strictEqual(out.evidence_runs, 1, 'projected hard pressure should throttle to one evidence run');

  out = computeEvidenceRunPlan(0, 'hard', 'hard');
  assert.strictEqual(out.configured_runs, 0);
  assert.strictEqual(out.evidence_runs, 0, 'zero configured runs should remain zero');

  out = computeEvidenceRunPlan('not-a-number', '', '');
  assert.strictEqual(out.configured_runs, 2, 'invalid configured runs should fallback to 2');
  assert.strictEqual(out.evidence_runs, 2);

  out = computeEvidenceRunPlan(99, 'none', 'none');
  assert.strictEqual(out.configured_runs, 6, 'configured runs should be clamped to max 6');
  assert.strictEqual(out.evidence_runs, 6);

  console.log('spine_evidence_run_plan.test.js: OK');
} catch (err) {
  console.error(`spine_evidence_run_plan.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


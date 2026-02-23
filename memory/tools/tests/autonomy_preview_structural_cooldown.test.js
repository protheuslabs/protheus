#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

try {
  assert.strictEqual(typeof controller.hasStructuralPreviewCriteriaFailure, 'function', 'expected exported structural detector');

  assert.strictEqual(
    controller.hasStructuralPreviewCriteriaFailure({
      primary_failure: 'success_criteria_failed:metric_not_allowed_for_capability'
    }),
    true,
    'metric_not_allowed primary failure should trigger structural cooldown'
  );

  assert.strictEqual(
    controller.hasStructuralPreviewCriteriaFailure({
      success_criteria: {
        contract_not_allowed_count: 1,
        unsupported_count: 0,
        total_count: 4
      }
    }),
    true,
    'contract_not_allowed_count>0 should trigger structural cooldown'
  );

  assert.strictEqual(
    controller.hasStructuralPreviewCriteriaFailure({
      success_criteria: {
        contract_not_allowed_count: 0,
        unsupported_count: 2,
        total_count: 4
      }
    }),
    true,
    'unsupported ratio >= 0.5 should trigger structural cooldown'
  );

  assert.strictEqual(
    controller.hasStructuralPreviewCriteriaFailure({
      success_criteria: {
        contract_not_allowed_count: 0,
        unsupported_count: 1,
        total_count: 4
      }
    }),
    false,
    'low unsupported ratio without contract violation should not trigger structural cooldown'
  );

  console.log('autonomy_preview_structural_cooldown.test.js: OK');
} catch (err) {
  console.error(`autonomy_preview_structural_cooldown.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


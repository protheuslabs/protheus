#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsAssessSuccessCriteriaQuality(criteria) {
  const src = criteria && typeof criteria === 'object' ? criteria : {};
  const checks = Array.isArray(src.checks) ? src.checks : [];
  const totalCount = Number(src.total_count || 0);
  const unknownExemptReasons = new Set([
    'artifact_delta_unavailable',
    'entry_delta_unavailable',
    'revenue_delta_unavailable',
    'outreach_artifact_unavailable',
    'reply_or_interview_count_unavailable',
    'deferred_pending_window'
  ]);
  const unknownExemptCount = checks.filter((row) => {
    if (!row || row.evaluated === true) return false;
    const reason = String(row.reason || '');
    return unknownExemptReasons.has(reason);
  }).length;
  const unknownCountRaw = Number(src.unknown_count || 0);
  const unknownCount = Math.max(0, unknownCountRaw - unknownExemptCount);
  const unknownRate = totalCount > 0
    ? (unknownCount / totalCount)
    : (checks.length > 0
      ? (Math.max(0, checks.filter((row) => !(row && row.evaluated === true)).length - unknownExemptCount) / checks.length)
      : 1);
  const unsupportedCount = checks.filter((row) => {
    const reason = String(row && row.reason || '');
    return reason === 'unsupported_metric' || reason === 'metric_not_allowed_for_capability';
  }).length;
  const unsupportedRate = checks.length > 0 ? (unsupportedCount / checks.length) : 0;
  const synthesized = src.synthesized === true;
  const reasons = [];
  if (synthesized) reasons.push('synthesized_criteria');
  if (unknownRate > 0.4) reasons.push('high_unknown_rate');
  if (unsupportedRate > 0.5) reasons.push('high_unsupported_rate');
  return {
    insufficient: reasons.length > 0,
    reasons,
    total_count: totalCount,
    unknown_count_raw: unknownCountRaw,
    unknown_exempt_count: unknownExemptCount,
    unknown_count: unknownCount,
    unknown_rate: Number(unknownRate.toFixed(4)),
    unsupported_count: unsupportedCount,
    unsupported_rate: Number(unsupportedRate.toFixed(4)),
    synthesized
  };
}

function rustAssessSuccessCriteriaQuality(criteria) {
  const src = criteria && typeof criteria === 'object' ? criteria : {};
  const checks = Array.isArray(src.checks) ? src.checks : [];
  const rust = runBacklogAutoscalePrimitive(
    'assess_success_criteria_quality',
    {
      checks: checks.map((row) => ({
        evaluated: row && row.evaluated === true,
        reason: row && row.reason == null ? null : String(row && row.reason || '')
      })),
      total_count: Number(src.total_count || 0),
      unknown_count: Number(src.unknown_count || 0),
      synthesized: src.synthesized === true
    },
    { allow_cli_fallback: true }
  );
  assert(rust && rust.ok === true, 'rust bridge invocation failed');
  assert(rust.payload && rust.payload.ok === true, 'rust payload failed');
  return rust.payload.payload;
}

function run() {
  const samples = [
    {
      checks: [
        { evaluated: false, reason: 'unsupported_metric' },
        { evaluated: false, reason: 'artifact_delta_unavailable' },
        { evaluated: true, reason: 'ok' }
      ],
      total_count: 3,
      unknown_count: 2,
      synthesized: true
    },
    {
      checks: [],
      total_count: 0,
      unknown_count: 0,
      synthesized: false
    }
  ];

  for (const sample of samples) {
    const expected = jsAssessSuccessCriteriaQuality(sample);
    const got = rustAssessSuccessCriteriaQuality(sample);
    assert.deepStrictEqual(got, expected, `assessSuccessCriteriaQuality mismatch for sample=${JSON.stringify(sample)}`);
  }

  console.log('autonomy_assess_success_criteria_quality_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_assess_success_criteria_quality_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadController(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function normalize(out) {
  const row = out && typeof out === 'object' ? out : {};
  return {
    pass: row.pass === true,
    score: Number(row.score || 0),
    score_source: String(row.score_source || ''),
    eye_id: String(row.eye_id || ''),
    sensory_relevance_score: Number.isFinite(Number(row.sensory_relevance_score))
      ? Number(row.sensory_relevance_score)
      : null,
    sensory_relevance_tier: row.sensory_relevance_tier == null ? null : String(row.sensory_relevance_tier),
    sensory_quality_score: Number.isFinite(Number(row.sensory_quality_score))
      ? Number(row.sensory_quality_score)
      : null,
    sensory_quality_tier: row.sensory_quality_tier == null ? null : String(row.sensory_quality_tier),
    eye_status: row.eye_status == null ? null : String(row.eye_status),
    eye_score_ema: Number.isFinite(Number(row.eye_score_ema)) ? Number(row.eye_score_ema) : null,
    parser_type: row.parser_type == null ? null : String(row.parser_type),
    domain: row.domain == null ? null : String(row.domain),
    calibration_eye_bias: Number(Number(row.calibration_eye_bias || 0).toFixed(3)),
    calibration_topic_bias: Number(Number(row.calibration_topic_bias || 0).toFixed(3)),
    calibration_total_bias: Number(Number(row.calibration_total_bias || 0).toFixed(3)),
    reasons: Array.isArray(row.reasons)
      ? row.reasons.map((x) => String(x || ''))
      : []
  };
}

function run() {
  const ts = loadController(false);
  const rust = loadController(true);

  const proposal = {
    id: 'p-signal-1',
    title: 'Boost conversion via targeted follow-up',
    expected_impact: 'high',
    risk: 'low',
    meta: {
      source_eye: 'eye_growth',
      relevance_score: 73,
      relevance_tier: 'high',
      signal_quality_score: 67,
      signal_quality_tier: 'high',
      url: 'https://example.com/post',
      topics: ['growth', 'conversion']
    },
    evidence: [{ evidence_url: 'https://example.com/post' }]
  };

  const eyesMap = new Map([
    ['eye_growth', {
      id: 'eye_growth',
      status: 'active',
      parser_type: 'rss',
      score_ema: 64,
      proposed_total: 8,
      yield_rate: 0.36,
      allowed_domains: ['example.com']
    }]
  ]);

  const thresholds = {
    min_signal_quality: 45,
    min_sensory_signal_score: 40,
    min_sensory_relevance_score: 42,
    min_eye_score_ema: 45
  };

  const calibrationProfile = {
    eye_biases: {
      eye_growth: { bias: 1.5 }
    },
    topic_biases: {
      growth: { bias: 0.6 },
      conversion: { bias: 0.2 }
    }
  };

  const expected = normalize(ts.assessSignalQuality(proposal, eyesMap, thresholds, calibrationProfile));
  const got = normalize(rust.assessSignalQuality(proposal, eyesMap, thresholds, calibrationProfile));
  assert.deepStrictEqual(got, expected, 'assessSignalQuality mismatch');

  console.log('autonomy_assess_signal_quality_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_assess_signal_quality_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

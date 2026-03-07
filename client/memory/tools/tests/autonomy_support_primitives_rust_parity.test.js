#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function approxEqual(a, b, epsilon = 1e-3) {
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

function run() {
  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tokenSamples = ['revenue', ' delivery ', 'unknown', '', null];
  for (const sample of tokenSamples) {
    assert.strictEqual(
      rust.normalizeValueCurrencyToken(sample),
      ts.normalizeValueCurrencyToken(sample),
      `normalizeValueCurrencyToken mismatch for ${String(sample)}`
    );
  }

  const listSamples = [
    ['revenue', 'delivery', 'revenue'],
    'user_value, quality, invalid, time_savings',
    [],
    ''
  ];
  for (const sample of listSamples) {
    assert.deepStrictEqual(
      rust.listValueCurrencies(sample),
      ts.listValueCurrencies(sample),
      `listValueCurrencies mismatch for ${JSON.stringify(sample)}`
    );
  }

  const inferBits = [
    'Ship backlog faster with better delivery throughput',
    'Improve retention and onboarding quality',
    'Research hypothesis to learn new insights'
  ];
  assert.deepStrictEqual(
    rust.inferValueCurrenciesFromDirectiveBits(inferBits),
    ts.inferValueCurrenciesFromDirectiveBits(inferBits),
    'inferValueCurrenciesFromDirectiveBits mismatch'
  );

  const linkedEntry = {
    objective_id: 'T1_build_runtime',
    directive_objective_id: '',
    directive: 'N/A'
  };
  assert.strictEqual(
    rust.hasLinkedObjectiveEntry(linkedEntry),
    ts.hasLinkedObjectiveEntry(linkedEntry),
    'hasLinkedObjectiveEntry mismatch'
  );

  const outcomeEntry = { outcome_verified: false, outcome: 'verified_success' };
  assert.strictEqual(
    rust.isVerifiedEntryOutcome(outcomeEntry),
    ts.isVerifiedEntryOutcome(outcomeEntry),
    'isVerifiedEntryOutcome mismatch'
  );

  const revenueAction = { verified: false, outcome_verified: false, status: 'received' };
  assert.strictEqual(
    rust.isVerifiedRevenueAction(revenueAction),
    ts.isVerifiedRevenueAction(revenueAction),
    'isVerifiedRevenueAction mismatch'
  );

  const nowMs = Date.UTC(2026, 2, 4, 12, 15, 0, 0);
  assert.strictEqual(
    rust.minutesUntilNextUtcDay(nowMs),
    ts.minutesUntilNextUtcDay(nowMs),
    'minutesUntilNextUtcDay mismatch'
  );

  const tsAge = ts.ageHours('2026-03-03');
  const rustAge = rust.ageHours('2026-03-03');
  assert(
    approxEqual(tsAge, rustAge, 0.01),
    `ageHours mismatch: ts=${tsAge} rust=${rustAge}`
  );

  const url = 'https://example.com/path?q=1';
  assert.strictEqual(rust.urlDomain(url), ts.urlDomain(url), 'urlDomain mismatch');

  const allowlist = ['example.com', 'acme.dev'];
  assert.strictEqual(
    rust.domainAllowed('sub.example.com', allowlist),
    ts.domainAllowed('sub.example.com', allowlist),
    'domainAllowed mismatch'
  );

  const execModes = ['execute', 'canary_execute', 'score_only', '', null];
  for (const mode of execModes) {
    assert.strictEqual(
      rust.isExecuteMode(mode),
      ts.isExecuteMode(mode),
      `isExecuteMode mismatch for ${String(mode)}`
    );
  }

  for (const envValue of ['0', '1']) {
    process.env.AUTONOMY_ENABLED = envValue;
    const execCases = [
      { mode: 'execute', shadow: false },
      { mode: 'canary_execute', shadow: false },
      { mode: 'score_only', shadow: false },
      { mode: 'execute', shadow: true }
    ];
    for (const sample of execCases) {
      assert.strictEqual(
        rust.executionAllowedByFeatureFlag(sample.mode, sample.shadow),
        ts.executionAllowedByFeatureFlag(sample.mode, sample.shadow),
        `executionAllowedByFeatureFlag mismatch for ${JSON.stringify(sample)} env=${envValue}`
      );
    }
  }

  const objectiveIdSamples = ['T1_growth', 't1:core', 'T2_misc', '', null];
  for (const sample of objectiveIdSamples) {
    assert.strictEqual(
      rust.isTier1ObjectiveId(sample),
      ts.isTier1ObjectiveId(sample),
      `isTier1ObjectiveId mismatch for ${String(sample)}`
    );
  }

  const tier1CandidateSamples = [
    { objective_binding: { objective_id: 'T1_pipeline' }, directive_pulse: { tier: 2 } },
    { objective_binding: { objective_id: 'T2_quality' }, directive_pulse: { tier: 1 } },
    { objective_binding: { objective_id: 'T2_quality' }, directive_pulse: { tier: 3, objective_id: 'T1_ops' } },
    { objective_binding: { objective_id: 'T2_quality' }, directive_pulse: { tier: 3 } }
  ];
  for (const sample of tier1CandidateSamples) {
    assert.strictEqual(
      rust.isTier1CandidateObjective(sample),
      ts.isTier1CandidateObjective(sample),
      `isTier1CandidateObjective mismatch for ${JSON.stringify(sample)}`
    );
  }

  const quotaSamples = [
    { mode: 'execute', shadow: false, executed: 0 },
    { mode: 'canary_execute', shadow: false, executed: 5 },
    { mode: 'score_only', shadow: false, executed: 0 },
    { mode: 'execute', shadow: true, executed: 0 }
  ];
  for (const sample of quotaSamples) {
    assert.strictEqual(
      rust.needsExecutionQuota(sample.mode, sample.shadow, sample.executed),
      ts.needsExecutionQuota(sample.mode, sample.shadow, sample.executed),
      `needsExecutionQuota mismatch for ${JSON.stringify(sample)}`
    );
  }

  const metricSamples = ['Time-To Value', ' quality score ', null, ''];
  for (const sample of metricSamples) {
    assert.strictEqual(
      rust.normalizeCriteriaMetric(sample),
      ts.normalizeCriteriaMetric(sample),
      `normalizeCriteriaMetric mismatch for ${String(sample)}`
    );
  }

  const regexSample = 'a+b(c)?[x]';
  assert.strictEqual(
    rust.escapeRegExp(regexSample),
    ts.escapeRegExp(regexSample),
    'escapeRegExp mismatch'
  );

  const toolTokenSamples = [
    { blob: 'use bird_x and eyes', token: 'bird_x' },
    { blob: 'plan includes BIRD-X alias', token: 'bird_x' },
    { blob: 'track policy guard', token: 'guard' },
    { blob: '', token: 'guard' }
  ];
  for (const sample of toolTokenSamples) {
    assert.strictEqual(
      rust.toolTokenMentioned(sample.blob, sample.token),
      ts.toolTokenMentioned(sample.blob, sample.token),
      `toolTokenMentioned mismatch for ${JSON.stringify(sample)}`
    );
  }

  const holdReasonSamples = [
    { hold_reason: 'manual gate', route_block_reason: '', result: 'noop' },
    { hold_reason: '', route_block_reason: 'policy block', result: '' },
    { result: 'stop_init_gate_policy_hold' },
    {}
  ];
  for (const sample of holdReasonSamples) {
    assert.strictEqual(
      rust.policyHoldReasonFromEvent(sample),
      ts.policyHoldReasonFromEvent(sample),
      `policyHoldReasonFromEvent mismatch for ${JSON.stringify(sample)}`
    );
  }

  const strategySample = {
    objective: {
      primary: 'Improve delivery throughput',
      fitness_metric: 'Lead-Time',
      secondary: ['Quality', 'User Value']
    },
    tags: ['ops', 'Delivery']
  };
  assert.deepStrictEqual(
    rust.strategyMarkerTokens(strategySample),
    ts.strategyMarkerTokens(strategySample),
    'strategyMarkerTokens mismatch'
  );

  console.log('autonomy_support_primitives_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_support_primitives_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

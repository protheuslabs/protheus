#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  duality_evaluate,
  registerDualityObservation,
  loadDualityState,
  maybeRunSelfValidation
} = require('../../../lib/duality_seed.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duality-seed-'));
  const policyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  const codexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');
  const latestPath = path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest.json');
  const historyPath = path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history.jsonl');

  writeText(codexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability,planning|yang_attrs=exploration,novelty,adaptation',
    '',
    '[flow_values]',
    'life/death',
    'progression/degression',
    '',
    '[balance_rules]',
    'positive_balance=creates_energy',
    'negative_balance=destroys',
    '',
    '[asymptote]',
    'zero_point=opposites_flow_into_each_other',
    'harmony=balanced_interplay_enables_impossible',
    '',
    '[warnings]',
    'single_pole_optimization_causes_debt'
  ].join('\n'));

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    advisory_weight: 0.4,
    positive_threshold: 0.2,
    negative_threshold: -0.2,
    contradiction_decay_step: 0.05,
    support_recovery_step: 0.01,
    self_validation_interval_minutes: 5,
    codex_path: codexPath,
    state: {
      latest_path: latestPath,
      history_path: historyPath
    },
    integration: {
      belief_formation: true,
      inversion_trigger: true,
      assimilation_candidacy: true,
      task_decomposition: true,
      weaver_arbitration: true,
      heroic_echo_filtering: true
    },
    outputs: {
      persist_shadow_receipts: true,
      persist_observations: true
    }
  });

  const balanced = duality_evaluate({
    lane: 'weaver_arbitration',
    objective: 'maintain order and exploration in balance',
    source: 'test'
  }, {
    policy_path: policyPath,
    persist: true
  });
  assert.strictEqual(balanced.enabled, true, 'duality must be enabled for configured lane');
  assert.ok(
    Number(balanced.zero_point_harmony_potential || 0) >= 0,
    'duality should compute harmony potential'
  );
  assert.ok(
    typeof balanced.recommended_adjustment === 'string' && balanced.recommended_adjustment.length > 0,
    'duality should emit recommended adjustment'
  );

  const stateBefore = loadDualityState(policyPath);
  const contradiction = registerDualityObservation({
    lane: 'weaver_arbitration',
    source: 'test',
    predicted_trit: 1,
    observed_trit: -1
  }, {
    policy_path: policyPath
  });
  assert.strictEqual(contradiction.ok, true, 'observation write should succeed');
  const stateAfter = loadDualityState(policyPath);
  assert.ok(
    Number(stateAfter.seed_confidence || 0) <= Number(stateBefore.seed_confidence || 1),
    'seed confidence should decay on contradiction'
  );

  maybeRunSelfValidation(policyPath, JSON.parse(fs.readFileSync(policyPath, 'utf8')), stateAfter);
  const validated = loadDualityState(policyPath);
  assert.ok(
    validated.self_validation && typeof validated.self_validation.last_run_ts === 'string',
    'self validation should persist run timestamp'
  );

  const disabledPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.disabled.json');
  writeJson(disabledPolicyPath, {
    version: '1.0-test',
    enabled: true,
    codex_path: codexPath,
    state: {
      latest_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest-disabled.json'),
      history_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history-disabled.jsonl')
    },
    integration: {
      weaver_arbitration: false
    }
  });
  const laneDisabled = duality_evaluate({
    lane: 'weaver_arbitration',
    objective: 'balance objective'
  }, {
    policy_path: disabledPolicyPath
  });
  assert.strictEqual(laneDisabled.enabled, false, 'lane disabled integration should short-circuit signal');
  assert.strictEqual(laneDisabled.lane_enabled, false, 'lane toggle should be reflected in response');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('duality_seed.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`duality_seed.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

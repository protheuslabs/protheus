#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(ROOT, 'systems', 'autonomy', 'model_catalog_loop.js');

function main() {
  const mod = require(MODULE_PATH);
  assert.ok(mod && typeof mod.evaluateRiskTierChain === 'function', 'evaluateRiskTierChain export should exist');

  const policy = {
    risk_tier_chain: {
      enabled: true,
      require_all_stages: true,
      stages: [
        { id: 'cheap', risk: 'low', complexity: 'low', intent: 'cheap', task: 'cheap' },
        { id: 'deep', risk: 'high', complexity: 'high', intent: 'deep', task: 'deep' },
        { id: 'critique', risk: 'medium', complexity: 'high', intent: 'critique', task: 'critique' }
      ]
    }
  };

  const failOne = mod.evaluateRiskTierChain('ollama/test', policy, (_model, stage) => ({
    ok: true,
    eligible: stage.id !== 'critique',
    rank_score: stage.id === 'cheap' ? 10 : stage.id === 'deep' ? 14 : 4,
    outcome_score: 0,
    reasons: []
  }));
  assert.strictEqual(failOne.enabled, true, 'chain should be enabled');
  assert.strictEqual(failOne.total_stages, 3, 'stage count should match');
  assert.strictEqual(failOne.passed_stages, 2, 'only two stages should pass');
  assert.strictEqual(failOne.passed, false, 'all-stage requirement should fail');

  const passAll = mod.evaluateRiskTierChain('ollama/test', policy, (_model, stage) => ({
    ok: true,
    eligible: true,
    rank_score: stage.id === 'cheap' ? 8 : stage.id === 'deep' ? 12 : 10,
    outcome_score: 0,
    reasons: []
  }));
  assert.strictEqual(passAll.passed, true, 'all-stage requirement should pass');
  assert.strictEqual(passAll.chain_score, 10, 'chain score should average rank scores');

  console.log('model_catalog_loop_risk_chain.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`model_catalog_loop_risk_chain.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

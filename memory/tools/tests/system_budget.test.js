#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  loadSystemBudgetState,
  projectSystemBudget,
  recordSystemBudgetUsage
} = require(path.join(REPO_ROOT, 'systems', 'budget', 'system_budget.js'));

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'system-budget-test-'));
  try {
    const stateDir = path.join(tempRoot, 'budget');
    const day = '2026-02-21';

    const initial = loadSystemBudgetState(day, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000
    });
    assert.strictEqual(initial.date, day);
    assert.strictEqual(Number(initial.token_cap), 1000);
    assert.strictEqual(Number(initial.used_est), 0);

    const afterRecord = recordSystemBudgetUsage({
      date: day,
      tokens_est: 180,
      module: 'reflex',
      capability: 'spawn'
    }, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000
    });
    assert.strictEqual(Number(afterRecord.used_est), 180);
    assert.strictEqual(Number(afterRecord.by_module.reflex.used_est), 180);

    const projected = projectSystemBudget(afterRecord, 820, {
      soft_ratio: 0.75,
      hard_ratio: 0.92
    });
    assert.strictEqual(Number(projected.request_tokens_est), 820);
    assert.strictEqual(Number(projected.projected_used_est), 1000);
    assert.strictEqual(Number(projected.projected_ratio), 1);
    assert.strictEqual(String(projected.projected_pressure), 'hard');

    console.log('✅ system_budget.test.js PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`❌ system_budget.test.js failed: ${err.message}`);
  process.exit(1);
}

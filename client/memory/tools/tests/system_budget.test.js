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
  recordSystemBudgetUsage,
  writeSystemBudgetDecision,
  migrateSystemBudgetState,
  evaluateSystemBudgetGuard,
  loadSystemBudgetAutopauseState,
  setSystemBudgetAutopause,
  clearSystemBudgetAutopause
} = require(path.join(REPO_ROOT, 'systems', 'budget', 'system_budget.js'));

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'system-budget-test-'));
  try {
    const stateDir = path.join(tempRoot, 'budget');
    const eventsPath = path.join(tempRoot, 'budget_events.jsonl');
    const autopausePath = path.join(tempRoot, 'budget_autopause.json');
    const day = '2026-02-21';

    const initial = loadSystemBudgetState(day, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000
    });
    assert.strictEqual(String(initial.schema_id), 'system_budget_state');
    assert.strictEqual(String(initial.schema_version), '1.0.0');
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
      events_path: eventsPath,
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

    const decision = writeSystemBudgetDecision({
      date: day,
      module: 'sensory_focus',
      capability: 'focus_fetch',
      request_tokens_est: 820,
      decision: 'degrade',
      reason: 'focus_budget_pressure'
    }, {
      state_dir: stateDir,
      events_path: eventsPath,
      soft_ratio: 0.75,
      hard_ratio: 0.92
    });
    assert.strictEqual(String(decision.decision), 'degrade');
    assert.strictEqual(Number(decision.request_tokens_est), 820);
    assert.strictEqual(String(decision.module), 'sensory_focus');
    assert.strictEqual(String(decision.type), 'system_budget_decision');
    assert.ok(fs.existsSync(eventsPath), 'decision ledger should be written');
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'decision ledger should have rows');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(String(last.schema_id), 'system_budget_event');
    assert.strictEqual(String(last.schema_version), '1.0.0');
    assert.strictEqual(String(last.type), 'system_budget_decision');
    assert.strictEqual(String(last.decision), 'degrade');
    assert.strictEqual(String(last.reason), 'focus_budget_pressure');

    const priorDays = [
      '2026-02-14',
      '2026-02-15',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20'
    ];
    for (const d of priorDays) {
      recordSystemBudgetUsage({
        date: d,
        tokens_est: 100,
        module: 'baseline',
        capability: 'sample'
      }, {
        state_dir: stateDir,
        events_path: eventsPath,
        allow_strategy: false,
        daily_token_cap: 1000
      });
    }
    const burnGuard = evaluateSystemBudgetGuard({
      date: day,
      request_tokens_est: 900
    }, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000
    });
    assert.strictEqual(Boolean(burnGuard.hard_stop), true, 'burn-rate guard should hard stop');
    assert.ok(Array.isArray(burnGuard.hard_stop_reasons) && burnGuard.hard_stop_reasons.includes('burn_rate_exceeded'));

    const monthlyGuard = evaluateSystemBudgetGuard({
      date: day,
      request_tokens_est: 100
    }, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000,
      token_cost_per_1k: 10,
      monthly_usd_allocation: 1,
      monthly_credits_floor_pct: 0.2
    });
    assert.strictEqual(Boolean(monthlyGuard.hard_stop), true, 'monthly floor guard should hard stop');
    assert.ok(
      Array.isArray(monthlyGuard.hard_stop_reasons) && monthlyGuard.hard_stop_reasons.includes('monthly_credits_floor_breached'),
      'monthly floor guard should report floor breach'
    );

    const legacyDay = '2026-02-20';
    const legacyPath = path.join(stateDir, `${legacyDay}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({
      date: legacyDay,
      token_cap: 900,
      used_est: 77,
      by_module: { legacy: { used_est: 77 } }
    }, null, 2));
    const migration = migrateSystemBudgetState(legacyDay, {
      state_dir: stateDir,
      allow_strategy: false,
      daily_token_cap: 1000
    });
    assert.strictEqual(Boolean(migration.migrated), true);
    const migrated = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    assert.strictEqual(String(migrated.schema_id), 'system_budget_state');
    assert.strictEqual(String(migrated.schema_version), '1.0.0');
    assert.strictEqual(String(migrated.date), legacyDay);
    assert.strictEqual(Number(migrated.token_cap), 900);

    const autopauseInitial = loadSystemBudgetAutopauseState({ autopause_path: autopausePath });
    assert.strictEqual(Boolean(autopauseInitial.active), false);
    assert.strictEqual(Number(autopauseInitial.until_ms || 0), 0);

    const autopauseSet = setSystemBudgetAutopause({
      source: 'system_budget_test',
      reason: 'test_pause',
      pressure: 'hard',
      minutes: 15
    }, { autopause_path: autopausePath });
    assert.strictEqual(Boolean(autopauseSet.active), true);
    assert.strictEqual(String(autopauseSet.source), 'system_budget_test');
    assert.ok(Number(autopauseSet.until_ms) > Date.now(), 'autopause set should create future until_ms');

    const autopauseCleared = clearSystemBudgetAutopause({
      source: 'system_budget_test',
      reason: 'test_clear'
    }, { autopause_path: autopausePath });
    assert.strictEqual(Boolean(autopauseCleared.active), false);
    assert.strictEqual(Number(autopauseCleared.until_ms || 0), 0);
    assert.strictEqual(String(autopauseCleared.source), 'system_budget_test');
    assert.strictEqual(String(autopauseCleared.clear_reason), 'test_clear');

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

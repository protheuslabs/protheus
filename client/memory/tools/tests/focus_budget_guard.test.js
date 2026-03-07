#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const focusPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'focus_triggers.json');
  const before = fs.existsSync(focusPath) ? fs.readFileSync(focusPath, 'utf8') : null;
  const tmpRoot = path.join(__dirname, 'temp_focus_budget_guard');

  const envBefore = {
    FOCUS_SENSORY_DIR: process.env.FOCUS_SENSORY_DIR,
    FOCUS_FETCH_ENABLED: process.env.FOCUS_FETCH_ENABLED,
    FOCUS_BUDGET_ENABLED: process.env.FOCUS_BUDGET_ENABLED,
    FOCUS_BUDGET_STATE_DIR: process.env.FOCUS_BUDGET_STATE_DIR,
    FOCUS_BUDGET_EVENTS_PATH: process.env.FOCUS_BUDGET_EVENTS_PATH,
    FOCUS_BUDGET_AUTOPAUSE_PATH: process.env.FOCUS_BUDGET_AUTOPAUSE_PATH,
    OUTCOME_FITNESS_POLICY_PATH: process.env.OUTCOME_FITNESS_POLICY_PATH
  };

  try {
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    mkDir(tmpRoot);

    const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
    const budgetDir = path.join(tmpRoot, 'state', 'budget');
    const budgetEventsPath = path.join(tmpRoot, 'state', 'budget_events.jsonl');
    const autopausePath = path.join(tmpRoot, 'state', 'budget_autopause.json');

    process.env.FOCUS_SENSORY_DIR = sensoryDir;
    process.env.FOCUS_FETCH_ENABLED = '0';
    process.env.FOCUS_BUDGET_ENABLED = '1';
    process.env.FOCUS_BUDGET_STATE_DIR = budgetDir;
    process.env.FOCUS_BUDGET_EVENTS_PATH = budgetEventsPath;
    process.env.FOCUS_BUDGET_AUTOPAUSE_PATH = autopausePath;
    process.env.OUTCOME_FITNESS_POLICY_PATH = path.join(tmpRoot, 'no_outcome_policy.json');

    writeJson(autopausePath, {
      schema_id: 'system_budget_autopause',
      schema_version: '1.0.0',
      active: true,
      source: 'focus_budget_guard_test',
      reason: 'test_pause',
      pressure: 'hard',
      date: '2026-02-22',
      until_ms: Date.now() + (20 * 60 * 1000),
      until: new Date(Date.now() + (20 * 60 * 1000)).toISOString(),
      updated_at: new Date().toISOString()
    });

    const store = require('../../../systems/adaptive/sensory/eyes/focus_trigger_store.js');
    const focus = require('../../../systems/sensory/focus_controller.js');

    store.mutateFocusState(null, (state) => {
      const next = { ...state };
      next.policy = {
        ...(next.policy || {}),
        min_focus_score: 10,
        dynamic_focus_gate_enabled: false
      };
      next.triggers = [
        {
          key: 'token:alpha',
          pattern: 'alpha',
          source: 'manual',
          status: 'active',
          weight: 95,
          cooldown_minutes: 0
        }
      ];
      return next;
    }, { reason: 'focus_budget_guard_test_seed' });

    const evalRes = await focus.evaluateFocusForEye({
      eye: { id: 'budget_eye', parser_type: 'hn_rss' },
      dateStr: '2026-02-22',
      maxFocusPerEye: 2,
      remainingRunBudget: 2,
      items: [
        {
          id: 'i1',
          collected_at: '2026-02-22T00:00:00.000Z',
          title: 'Alpha routing note',
          url: 'https://example.com/alpha',
          topics: ['routing'],
          bytes: 100
        }
      ]
    });

    assert.strictEqual(evalRes.ok, true, 'focus evaluation should succeed');
    assert.strictEqual(String(evalRes.focus_budget.decision || ''), 'deny', 'budget decision should be deny');
    assert.strictEqual(String(evalRes.focus_budget.reason || ''), 'budget_autopause_active', 'deny reason should be autopause');
    assert.strictEqual(Number(evalRes.focus_budget.allowed_count || 0), 0, 'allowed count should be zero when autopause active');
    assert.strictEqual(Number(evalRes.detail_fetch_used || 0), 0, 'no detail fetches should run under autopause');

    const focused = Array.isArray(evalRes.items) ? evalRes.items.find((x) => x && x.focus_mode === 'focus') : null;
    assert.ok(focused, 'item should still be selected for focus mode');
    assert.strictEqual(String(focused.focus_detail_skipped_reason || ''), 'budget_autopause_active', 'focus detail should be skipped by budget reason');

    const decisionRows = fs.existsSync(budgetEventsPath)
      ? fs.readFileSync(budgetEventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.ok(decisionRows.length >= 1, 'budget decision ledger should receive denial row');
    const last = decisionRows[decisionRows.length - 1];
    assert.strictEqual(String(last.type || ''), 'system_budget_decision');
    assert.strictEqual(String(last.decision || ''), 'deny');
    assert.strictEqual(String(last.reason || ''), 'budget_autopause_active');

    console.log('focus_budget_guard.test.js: OK');
  } finally {
    if (envBefore.FOCUS_SENSORY_DIR == null) delete process.env.FOCUS_SENSORY_DIR;
    else process.env.FOCUS_SENSORY_DIR = envBefore.FOCUS_SENSORY_DIR;
    if (envBefore.FOCUS_FETCH_ENABLED == null) delete process.env.FOCUS_FETCH_ENABLED;
    else process.env.FOCUS_FETCH_ENABLED = envBefore.FOCUS_FETCH_ENABLED;
    if (envBefore.FOCUS_BUDGET_ENABLED == null) delete process.env.FOCUS_BUDGET_ENABLED;
    else process.env.FOCUS_BUDGET_ENABLED = envBefore.FOCUS_BUDGET_ENABLED;
    if (envBefore.FOCUS_BUDGET_STATE_DIR == null) delete process.env.FOCUS_BUDGET_STATE_DIR;
    else process.env.FOCUS_BUDGET_STATE_DIR = envBefore.FOCUS_BUDGET_STATE_DIR;
    if (envBefore.FOCUS_BUDGET_EVENTS_PATH == null) delete process.env.FOCUS_BUDGET_EVENTS_PATH;
    else process.env.FOCUS_BUDGET_EVENTS_PATH = envBefore.FOCUS_BUDGET_EVENTS_PATH;
    if (envBefore.FOCUS_BUDGET_AUTOPAUSE_PATH == null) delete process.env.FOCUS_BUDGET_AUTOPAUSE_PATH;
    else process.env.FOCUS_BUDGET_AUTOPAUSE_PATH = envBefore.FOCUS_BUDGET_AUTOPAUSE_PATH;
    if (envBefore.OUTCOME_FITNESS_POLICY_PATH == null) delete process.env.OUTCOME_FITNESS_POLICY_PATH;
    else process.env.OUTCOME_FITNESS_POLICY_PATH = envBefore.OUTCOME_FITNESS_POLICY_PATH;

    if (before == null) {
      if (fs.existsSync(focusPath)) fs.rmSync(focusPath, { force: true });
    } else {
      mkDir(path.dirname(focusPath));
      fs.writeFileSync(focusPath, before, 'utf8');
    }
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(`focus_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
});

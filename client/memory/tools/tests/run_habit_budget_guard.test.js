#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_run_habit_budget_guard');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const budgetStateDir = path.join(tmpRoot, 'state', 'autonomy', 'daily_budget');
  const budgetEventsPath = path.join(tmpRoot, 'state', 'autonomy', 'budget_events.jsonl');
  const budgetAutopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
  mkDir(budgetStateDir);
  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: true,
    set_ts: new Date().toISOString(),
    source: 'run_habit_budget_guard.test',
    reason: 'manual_pause',
    pressure: 'hard',
    date: new Date().toISOString().slice(0, 10),
    until_ms: Date.now() + (60 * 60 * 1000),
    until: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
    cleared_ts: null,
    clear_reason: null,
    updated_at: new Date().toISOString()
  });

  const script = path.join(repoRoot, 'habits', 'scripts', 'run_habit.js');
  const r = spawnSync('node', [
    script,
    '--id', 'nonexistent_habit',
    '--json', '{}',
    '--tokens_est', '200'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HABIT_BUDGET_STATE_DIR: budgetStateDir,
      HABIT_BUDGET_EVENTS_PATH: budgetEventsPath,
      HABIT_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath
    }
  });

  assert.strictEqual(r.status, 1, 'run_habit should fail under active budget autopause');
  assert.ok(String(r.stderr || '').includes('Habit execution blocked by budget guard'));
  assert.ok(!String(r.stderr || '').includes('Habit not found'));

  console.log('run_habit_budget_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`run_habit_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const stopPath = path.join(repoRoot, 'state', 'security', 'emergency_stop.json');
  const backupPath = `${stopPath}.test-backup-${Date.now()}`;
  const hadExisting = fs.existsSync(stopPath);
  if (hadExisting) {
    mkDir(path.dirname(backupPath));
    fs.copyFileSync(stopPath, backupPath);
  }

  const tmpRoot = path.join(__dirname, 'temp_route_execute_budget_guard');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  try {
    writeJson(stopPath, {
      engaged: false,
      scopes: [],
      updated_at: new Date().toISOString(),
      actor: 'test',
      reason: 'route_execute_budget_guard'
    });

    const budgetStateDir = path.join(tmpRoot, 'state', 'autonomy', 'daily_budget');
    const budgetEventsPath = path.join(tmpRoot, 'state', 'autonomy', 'budget_events.jsonl');
    const budgetAutopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
    mkDir(budgetStateDir);
    writeJson(budgetAutopausePath, {
      schema_id: 'system_budget_autopause',
      schema_version: '1.0.0',
      active: true,
      set_ts: new Date().toISOString(),
      source: 'route_execute_budget_guard.test',
      reason: 'manual_pause',
      pressure: 'hard',
      date: new Date().toISOString().slice(0, 10),
      until_ms: Date.now() + (60 * 60 * 1000),
      until: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      cleared_ts: null,
      clear_reason: null,
      updated_at: new Date().toISOString()
    });

    const script = path.join(repoRoot, 'systems', 'routing', 'route_execute.js');
    const r = spawnSync('node', [
      script,
      '--task', 'optimize recurring task flow',
      '--tokens_est', '900',
      '--repeats_14d', '3',
      '--errors_30d', '0'
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ROUTER_ENABLED: '0',
        ROUTE_EXECUTE_BUDGET_STATE_DIR: budgetStateDir,
        ROUTE_EXECUTE_BUDGET_EVENTS_PATH: budgetEventsPath,
        ROUTE_EXECUTE_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath
      }
    });

    assert.strictEqual(r.status, 0, `route_execute should exit 0 when budget blocks execution: ${r.stderr}`);
    const out = parseLastJsonLine(r.stdout);
    assert.ok(out && typeof out === 'object', 'route_execute should emit summary JSON');
    assert.strictEqual(out.budget_blocked, true);
    assert.strictEqual(out.executable, false);
    assert.ok(out.budget_global_guard && out.budget_global_guard.blocked === true);
    assert.ok(String(out.budget_block_reason || '').includes('budget_autopause_active'));

    console.log('route_execute_budget_guard.test.js: OK');
  } finally {
    if (hadExisting) {
      fs.copyFileSync(backupPath, stopPath);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.rmSync(stopPath, { force: true });
    }
  }
}

try {
  run();
} catch (err) {
  console.error(`route_execute_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

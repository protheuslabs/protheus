#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'autonomy_simulation_harness.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-sim-autopause-'));
  const dateStr = new Date().toISOString().slice(0, 10);

  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const proposalsDir = path.join(tmp, 'state', 'sensory', 'proposals');
  const budgetAutopausePath = path.join(tmp, 'state', 'autonomy', 'budget_autopause.json');

  // Live snapshot says currently active.
  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    active: true,
    until_ms: Date.now() + (5 * 60 * 1000),
    until: new Date(Date.now() + (5 * 60 * 1000)).toISOString(),
    updated_at: new Date().toISOString(),
    source: 'test_live_snapshot',
    reason: 'burn_rate_exceeded',
    pressure: 'hard'
  });

  // Window-derived signal says autopause is not active at end-of-window.
  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    {
      ts: new Date().toISOString(),
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      route_summary: {
        budget_global_guard: {
          autopause: {
            active: true,
            // Earlier than end-of-day, so "active_at_window_end" should be false.
            until: new Date(Date.now() + (5 * 60 * 1000)).toISOString()
          }
        }
      }
    }
  ]);

  writeJson(path.join(proposalsDir, `${dateStr}.json`), []);

  const env = {
    ...process.env,
    AUTONOMY_SIM_RUNS_DIR: runsDir,
    AUTONOMY_SIM_PROPOSALS_DIR: proposalsDir,
    AUTONOMY_SIM_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
    AUTONOMY_SIM_LINEAGE_REQUIRED: '0'
  };

  const proc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--days=1',
    '--write=0'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  assert.strictEqual(proc.status, 0, proc.stderr || 'harness run should pass');
  const payload = parsePayload(proc.stdout);
  assert.ok(payload && payload.ok === true, 'harness payload should parse');

  assert.ok(payload.budget_autopause && payload.budget_autopause.observed_in_window === true, 'derived window signal should exist');
  assert.strictEqual(Boolean(payload.budget_autopause.active_at_window_end), false, 'window-derived autopause should be inactive at end');
  assert.strictEqual(Boolean(payload.budget_autopause.snapshot_fallback_used), false, 'live snapshot fallback should not override window-derived signal');
  assert.strictEqual(String(payload.checks && payload.checks.budget_autopause_active && payload.checks.budget_autopause_active.status), 'pass', 'autopause check should pass when inactive at window end');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autonomy_simulation_harness_autopause_window.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_simulation_harness_autopause_window.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

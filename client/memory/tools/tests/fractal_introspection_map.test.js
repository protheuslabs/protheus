#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'introspection_map.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-introspection-'));
  const dateStr = '2026-02-25';

  const env = {
    ...process.env,
    FRACTAL_INTROSPECTION_DIR: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'introspection'),
    FRACTAL_INTROSPECTION_QUEUE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'sensory_queue.json'),
    FRACTAL_INTROSPECTION_RUNS_DIR: path.join(tmpRoot, 'state', 'autonomy', 'runs'),
    FRACTAL_INTROSPECTION_COOLDOWNS_PATH: path.join(tmpRoot, 'state', 'autonomy', 'capability_cooldowns.json'),
    FRACTAL_INTROSPECTION_AUTOPAUSE_PATH: path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json'),
    FRACTAL_INTROSPECTION_LEASE_PATH: path.join(tmpRoot, 'state', 'continuity', 'active_lease.json'),
    FRACTAL_MORPH_PLAN_DIR: path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'morph_plans')
  };

  writeJson(env.FRACTAL_INTROSPECTION_QUEUE_PATH, { pending: 100, total: 120 });
  writeJson(env.FRACTAL_INTROSPECTION_COOLDOWNS_PATH, {
    cap_a: { until: '2026-02-26T00:00:00.000Z' },
    cap_b: { until: '2026-02-26T00:00:00.000Z' }
  });
  writeJson(env.FRACTAL_INTROSPECTION_AUTOPAUSE_PATH, {
    active: true,
    source: 'global_budget',
    reason: 'burn_rate_exceeded'
  });
  writeJson(env.FRACTAL_INTROSPECTION_LEASE_PATH, {
    holder: 'instance_a',
    expires_at: '2026-02-25T10:00:00.000Z'
  });
  writeJson(path.join(env.FRACTAL_MORPH_PLAN_DIR, `${dateStr}.json`), {
    plan_id: 'morph_test'
  });
  writeJsonl(path.join(env.FRACTAL_INTROSPECTION_RUNS_DIR, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped' }
  ]);

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run command should pass');
  const runOut = JSON.parse(String(runProc.stdout || '{}').trim());
  assert.strictEqual(runOut.ok, true);
  assert.ok(Number(runOut.nodes || 0) >= 5);
  assert.ok(Number(runOut.restructure_candidates || 0) >= 1);

  const outPath = path.join(env.FRACTAL_INTROSPECTION_DIR, `${dateStr}.json`);
  const snapshot = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.strictEqual(snapshot.ok, true);
  assert.ok(Array.isArray(snapshot.graph.nodes));
  assert.ok(Array.isArray(snapshot.restructure_candidates));
  assert.ok(snapshot.restructure_candidates.length > 0);

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status command should pass');
  const statusOut = JSON.parse(String(statusProc.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.restructure_candidates || 0) >= 1);

  console.log('fractal_introspection_map.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`fractal_introspection_map.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

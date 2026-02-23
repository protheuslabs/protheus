#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
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

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'memory', 'idle_dream_cycle.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-dream-cycle-'));
  const dreamsDir = path.join(tmpRoot, 'state', 'memory', 'dreams');
  const idleDir = path.join(dreamsDir, 'idle');
  const remDir = path.join(dreamsDir, 'rem');
  const failurePointersDir = path.join(tmpRoot, 'state', 'memory', 'failure_pointers');
  const routingPath = path.join(tmpRoot, 'state', 'routing', 'routing_decisions.jsonl');
  const statePath = path.join(dreamsDir, 'idle_state.json');
  const ledgerPath = path.join(dreamsDir, 'idle_runs.jsonl');
  const testDate = new Date().toISOString().slice(0, 10);

  mkDir(dreamsDir);
  mkDir(path.dirname(routingPath));

  writeJson(path.join(dreamsDir, '2026-02-21.json'), {
    ts: `${testDate}T12:00:00.000Z`,
    date: testDate,
    themes: [
      {
        token: 'memory-graph',
        score: 18,
        rows: [
          { memory_file: 'memory/2026-02-20.md', node_id: 'uid-connections' }
        ]
      },
      {
        token: 'strategy-signal',
        score: 14,
        rows: [
          { memory_file: 'memory/2026-02-20.md', node_id: 'strategy-learning' }
        ]
      }
    ]
  });

  fs.writeFileSync(
    routingPath,
    JSON.stringify({
      ts: `${testDate}T12:05:00.000Z`,
      type: 'route',
      mode: 'hyper-creative',
      tier: 2,
      intent: 'creative link synthesis from routing',
      task: 'bridge memory signals into adaptive strategy'
    }) + '\n',
    'utf8'
  );

  mkDir(failurePointersDir);
  fs.writeFileSync(
    path.join(failurePointersDir, `${testDate}.jsonl`),
    JSON.stringify({
      ts: `${testDate}T12:06:00.000Z`,
      failure_tier: 1,
      failure_count_window: 2,
      code: 'integrity_violation',
      title: 'Integrity policy mismatch',
      memory_file: `memory/${testDate}.md`,
      node_id: 'failure-t1-abc12345',
      topics: ['failure', 'failure-tier-1', 'integrity']
    }) + '\n',
    'utf8'
  );

  const env = {
    ...process.env,
    IDLE_DREAM_DREAMS_DIR: dreamsDir,
    IDLE_DREAM_IDLE_DIR: idleDir,
    IDLE_DREAM_REM_DIR: remDir,
    IDLE_DREAM_ROUTING_DECISIONS_PATH: routingPath,
    IDLE_DREAM_STATE_PATH: statePath,
    IDLE_DREAM_LEDGER_PATH: ledgerPath,
    IDLE_DREAM_FAILURE_POINTERS_DIR: failurePointersDir,
    IDLE_DREAM_SPAWN_BUDGET_ENABLED: '0',
    IDLE_DREAM_FAKE_MODELS: 'smallthinker,qwen3:4b',
    IDLE_DREAM_FAKE_IDLE_JSON: JSON.stringify({
      dream_links: [
        { token: 'memory-graph-bridge', hint: 'Bridge old and new memory nodes', confidence: 4, refs: ['memory/2026-02-20.md#uid-connections'] },
        { token: 'strategy-signal-loop', hint: 'Route strong sensory signal into strategy updates', confidence: 3, refs: [] }
      ]
    }),
    IDLE_DREAM_FAKE_REM_JSON: JSON.stringify({
      quantized: [
        { token: 'memory-graph-bridge', weight: 82, synthesis: 'High-repeat bridge pattern with execution relevance', source_uids: ['fake_uid_1'] }
      ]
    }),
    IDLE_DREAM_REM_MIN_IDLE_RUNS: '1',
    IDLE_DREAM_REM_MIN_MINUTES: '1'
  };

  let r = spawnSync('node', [script, 'run', testDate, '--force=1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.ok(out.idle && out.idle.skipped === false, 'idle phase should run');
  assert.ok(Number(out.idle.failure_seed_count || 0) >= 1, 'idle pass should reserve failure seeds');
  assert.ok(out.rem && out.rem.skipped === false, 'rem phase should run');

  const idleRows = fs.readFileSync(path.join(idleDir, `${testDate}.jsonl`), 'utf8').trim().split(/\r?\n/);
  assert.ok(idleRows.length >= 1, 'idle jsonl row should be written');
  const remToday = JSON.parse(fs.readFileSync(path.join(remDir, `${testDate}.json`), 'utf8'));
  assert.ok(Array.isArray(remToday.quantized) && remToday.quantized.length >= 1, 'rem quantized output should exist');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(state.last_idle_ts, 'state.last_idle_ts should exist');
  assert.ok(state.last_rem_ts, 'state.last_rem_ts should exist');
  assert.ok(Number(state.idle_runs || 0) >= 1, 'state.idle_runs should increment');
  assert.ok(Number(state.rem_runs || 0) >= 1, 'state.rem_runs should increment');

  const envFailure = {
    ...env,
    IDLE_DREAM_FAKE_MODEL_FAILURES: 'smallthinker:timeout'
  };
  r = spawnSync('node', [script, 'run', testDate, '--force=1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: envFailure
  });
  assert.strictEqual(r.status, 0, `failure run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'failure run expected ok=true');
  assert.ok(out.idle && out.idle.skipped === false, 'failure run should execute idle phase');
  assert.ok(Number(out.idle.failure_seed_count || 0) >= 1, 'degraded path should still report failure seed count');
  assert.ok(String(out.idle.failed_model || '').length > 0, 'failure run should mark failed model');
  assert.ok(out.idle.cooldown_until_ts, 'failure run should emit cooldown timestamp');

  const stateAfterFailure = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const failedModel = String(out.idle.failed_model || '');
  assert.ok(stateAfterFailure.model_health && stateAfterFailure.model_health[failedModel], 'state should track failed model health');
  assert.ok(Number(stateAfterFailure.model_health[failedModel].failure_streak || 0) >= 1, 'failed model should increment failure streak');
  assert.ok(stateAfterFailure.model_health[failedModel].cooldown_until_ts, 'failed model should have cooldown');

  r = spawnSync('node', [script, 'run', testDate, '--force=1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: envFailure
  });
  assert.strictEqual(r.status, 0, `post-cooldown run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'post-cooldown run expected ok=true');
  assert.ok(out.idle, 'post-cooldown run should return idle payload');
  if (out.idle.skipped === true) {
    const reason = String(out.idle.reason || '');
    assert.ok(
      reason === 'all_local_models_cooling_down' || reason === 'no_local_model_available',
      `unexpected idle skip reason: ${reason}`
    );
  } else {
    assert.ok(String(out.idle.model || '').length > 0, 'post-cooldown run should report selected model');
  }

  r = spawnSync('node', [script, 'status'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: envFailure
  });
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status expected ok=true');
  assert.ok(Number(out.idle_rows_today || 0) >= 1, 'status should report idle rows');
  assert.ok(out.rem_exists_today === true, 'status should report rem output');
  assert.ok(
    Array.isArray(out.active_model_cooldowns)
      && out.active_model_cooldowns.some((row) => String(row && row.model || '') === 'smallthinker'),
    'status should report active cooldown for failed model'
  );

  console.log('idle_dream_cycle.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`idle_dream_cycle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

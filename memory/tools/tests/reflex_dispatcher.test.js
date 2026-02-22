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

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'reflex', 'reflex_dispatcher.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_reflex_dispatcher');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const policyPath = path.join(tmpRoot, 'config', 'reflex_policy.json');
  const spawnPolicyPath = path.join(tmpRoot, 'config', 'spawn_policy.json');
  const spawnStateDir = path.join(tmpRoot, 'state', 'spawn');
  const stateDir = path.join(tmpRoot, 'state', 'adaptive', 'reflex');
  const budgetStateDir = path.join(tmpRoot, 'state', 'autonomy', 'daily_budget');
  const budgetEventsPath = path.join(tmpRoot, 'state', 'autonomy', 'budget_events.jsonl');
  const budgetAutopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
  const routerStub = path.join(tmpRoot, 'router_stub.js');
  const workerStub = path.join(tmpRoot, 'worker_stub.js');

  writeJson(policyPath, {
    version: '1.0',
    pool: {
      min_cells: 1,
      max_cells: 6,
      queue_per_cell: 2,
      scale_up_cooldown_sec: 0,
      scale_down_cooldown_sec: 0,
      demand_smoothing_alpha: 1,
      max_step_up: 4,
      max_step_down: 2,
      headroom_floor: 0.2,
      reserve_cpu_threads: 1,
      reserve_ram_gb: 1,
      estimated_cpu_threads_per_cell: 1,
      estimated_ram_gb_per_cell: 1,
      max_cells_by_hardware: {
        tiny: 1,
        small: 2,
        medium: 3,
        large: 4,
        xlarge: 6
      }
    },
    routing: {
      route_class: 'reflex',
      risk: 'low',
      complexity: 'low',
      default_role: 'reflex',
      default_tokens_est: 220,
      max_tokens_est: 420,
      timeout_ms: 10000,
      capability: 'reflex_micro'
    }
  });

  writeJson(spawnPolicyPath, {
    version: '1.0',
    pool: {
      min_cells: 0,
      max_cells: 6,
      reserve_cpu_threads: 1,
      reserve_ram_gb: 1,
      estimated_cpu_threads_per_cell: 1,
      estimated_ram_gb_per_cell: 1,
      max_cells_by_hardware: {
        tiny: 1,
        small: 2,
        medium: 4,
        large: 6,
        xlarge: 6
      }
    },
    quotas: {
      default_max_cells: 2,
      modules: {
        reflex: { max_cells: 2 }
      }
    },
    leases: {
      enabled: true,
      default_ttl_sec: 300,
      max_ttl_sec: 3600
    }
  });

  writeText(routerStub, `#!/usr/bin/env node\nconst cmd=process.argv[2]||'';\nif(cmd==='hardware-plan'){console.log(JSON.stringify({profile:{hardware_class:'small',cpu_threads:8,ram_gb:16},effective_local_models:['ollama/smallthinker']}));process.exit(0);}\nconsole.log(JSON.stringify({ok:true}));`);
  writeText(workerStub, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,worker_id:'cell-test',route:{selected_model:'ollama/smallthinker',route_class:'reflex'}}));`);

  const env = {
    ...process.env,
    REFLEX_POLICY_PATH: policyPath,
    REFLEX_STATE_DIR: stateDir,
    REFLEX_WORKER_SCRIPT: workerStub,
    SPAWN_POLICY_PATH: spawnPolicyPath,
    SPAWN_STATE_DIR: spawnStateDir,
    SPAWN_ROUTER_SCRIPT: routerStub,
    SYSTEM_BUDGET_STATE_DIR: budgetStateDir,
    SYSTEM_BUDGET_EVENTS_PATH: budgetEventsPath,
    SYSTEM_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
    REFLEX_BUDGET_STATE_DIR: budgetStateDir,
    REFLEX_BUDGET_EVENTS_PATH: budgetEventsPath,
    REFLEX_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath
  };

  let r = runScript(repoRoot, ['plan', '--demand=20', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `plan should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.plan.hardware_bounds.max_cells, 2, 'hardware cap should limit max cells to 2');
  assert.strictEqual(out.plan.spawn_allocation.granted_cells, 2, 'spawn broker should grant capped cells');
  assert.strictEqual(out.next_state.current_cells, 2, 'pool should scale to capped max');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(out.next_state.uid || '')), 'pool state uid should be alnum');

  r = runScript(repoRoot, ['plan', '--demand=0', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `plan downscale should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.next_state.current_cells, 1, 'pool should downscale back to min');

  r = runScript(repoRoot, ['run', '--task=classify tiny input', '--intent=heartbeat'], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.worker.result.route.route_class, 'reflex');
  assert.strictEqual(out.request_tokens_est, 220, 'run should report default token estimate');

  r = runScript(repoRoot, [
    'routine-create',
    '--id=triage_ping',
    '--task=triage tiny queue',
    '--intent=queue_health',
    '--demand=2',
    '--headroom=0.9',
    '--tokens_est=240',
    '--tags=ops,heartbeat'
  ], env);
  assert.strictEqual(r.status, 0, `routine-create should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result, 'created');
  assert.strictEqual(out.routine.id, 'triage_ping');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(out.routine.uid || '')), 'routine uid should be alnum');

  r = runScript(repoRoot, ['routine-list'], env);
  assert.strictEqual(r.status, 0, `routine-list should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.summary.total, 1);
  assert.strictEqual(out.routines[0].id, 'triage_ping');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(out.routines[0].uid || '')), 'listed routine uid should be alnum');

  r = runScript(repoRoot, ['routine-run', '--id=triage_ping'], env);
  assert.strictEqual(r.status, 0, `routine-run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.routine.id, 'triage_ping');
  assert.strictEqual(out.routine.use_count, 1);
  assert.strictEqual(out.worker.result.route.route_class, 'reflex');

  const eventsPath = path.join(stateDir, 'events.jsonl');
  const events = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.length >= 1, 'expected reflex events');
  assert.ok(events.every((e) => /^[A-Za-z0-9]+$/.test(String(e.uid || ''))), 'all reflex events should have alnum uid');

  r = runScript(repoRoot, ['routine-disable', '--id=triage_ping'], env);
  assert.strictEqual(r.status, 0, `routine-disable should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result, 'disabled');

  r = runScript(repoRoot, ['routine-run', '--id=triage_ping'], env);
  assert.strictEqual(r.status, 1, 'disabled routine should fail run');
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'routine_disabled');

  r = runScript(repoRoot, ['routine-enable', '--id=triage_ping'], env);
  assert.strictEqual(r.status, 0, `routine-enable should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result, 'enabled');

  r = runScript(repoRoot, ['routine-dispose', '--id=triage_ping'], env);
  assert.strictEqual(r.status, 0, `routine-dispose should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result, 'disposed');
  assert.strictEqual(out.summary.total, 0);

  writeJson(budgetAutopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: true,
    set_ts: new Date().toISOString(),
    source: 'reflex_dispatcher.test',
    reason: 'manual_pause',
    pressure: 'hard',
    date: '2026-02-22',
    until_ms: Date.now() + (60 * 60 * 1000),
    until: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
    cleared_ts: null,
    clear_reason: null,
    updated_at: new Date().toISOString()
  });

  r = runScript(repoRoot, ['run', '--task=should be blocked', '--intent=heartbeat'], env);
  assert.strictEqual(r.status, 1, 'run should be denied while budget autopause is active');
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'budget_guard_deny');
  assert.strictEqual(out.reason, 'budget_autopause_active');
  assert.strictEqual(!!(out.budget_autopause && out.budget_autopause.active), true);

  console.log('reflex_dispatcher.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`reflex_dispatcher.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

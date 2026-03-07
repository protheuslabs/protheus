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
  const script = path.join(repoRoot, 'systems', 'spawn', 'spawn_broker.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_spawn_broker');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const policyPath = path.join(tmpRoot, 'config', 'spawn_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'spawn');
  const budgetDir = path.join(tmpRoot, 'state', 'budget');
  const budgetEventsPath = path.join(tmpRoot, 'state', 'budget_events.jsonl');
  const autopausePath = path.join(tmpRoot, 'state', 'budget_autopause.json');
  const routerStub = path.join(tmpRoot, 'router_stub.js');

  writeJson(policyPath, {
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
      default_max_cells: 3,
      modules: {
        reflex: { max_cells: 2 },
        habits: { max_cells: 2 }
      }
    },
    leases: {
      enabled: true,
      default_ttl_sec: 300,
      max_ttl_sec: 3600
    }
  });

  writeText(
    routerStub,
    `#!/usr/bin/env node\nconst cmd=process.argv[2]||'';\nif(cmd==='hardware-plan'){console.log(JSON.stringify({profile:{hardware_class:'medium',cpu_threads:8,ram_gb:16}}));process.exit(0);}\nprocess.exit(1);`
  );

  const env = {
    ...process.env,
    SPAWN_POLICY_PATH: policyPath,
    SPAWN_STATE_DIR: stateDir,
    SPAWN_ROUTER_SCRIPT: routerStub,
    SPAWN_TOKEN_BUDGET_DIR: budgetDir,
    SPAWN_TOKEN_BUDGET_EVENTS_PATH: budgetEventsPath,
    SPAWN_TOKEN_BUDGET_AUTOPAUSE_PATH: autopausePath
  };

  writeJson(autopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: false,
    source: 'spawn_broker.test',
    reason: null,
    pressure: null,
    date: null,
    until_ms: 0,
    until: null,
    updated_at: new Date().toISOString()
  });

  let r = runScript(repoRoot, ['request', '--module=reflex', '--requested_cells=3', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `reflex request should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.granted_cells, 2, 'reflex should be capped by module quota');

  r = runScript(repoRoot, ['request', '--module=habits', '--requested_cells=2', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `habits request should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.granted_cells, 2, 'habits should consume remaining global capacity');

  r = runScript(repoRoot, ['request', '--module=strategy', '--requested_cells=2', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `strategy request should pass with zero grant: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.granted_cells, 0, 'strategy should be denied when no capacity remains');

  r = runScript(repoRoot, ['release', '--module=habits'], env);
  assert.strictEqual(r.status, 0, `habits release should pass: ${r.stderr}`);

  r = runScript(repoRoot, ['request', '--module=strategy', '--requested_cells=2', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `strategy second request should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.granted_cells, 2, 'strategy should receive capacity after habits release');

  r = runScript(repoRoot, ['status', '--module=reflex'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.limits.module_current_cells, 2, 'reflex current allocation should persist');
  assert.strictEqual(out.limits.global_max_cells, 4, 'hardware-class cap should be applied');
  assert.strictEqual(String(out.hardware_plan_transport || ''), 'spawn_sync', 'custom router script should use spawn_sync transport');
  assert.strictEqual(Boolean(out.budget_autopause && out.budget_autopause.active), false, 'autopause should be inactive');

  writeJson(autopausePath, {
    schema_id: 'system_budget_autopause',
    schema_version: '1.0.0',
    active: true,
    source: 'spawn_broker.test',
    reason: 'test_pause',
    pressure: 'hard',
    date: '2026-02-21',
    until_ms: Date.now() + (15 * 60 * 1000),
    until: new Date(Date.now() + (15 * 60 * 1000)).toISOString(),
    updated_at: new Date().toISOString()
  });
  r = runScript(repoRoot, ['request', '--module=reflex', '--requested_cells=1', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `budget-blocked request should return 0: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(Boolean(out.blocked_by_budget), true, 'request should be blocked by budget autopause');
  assert.strictEqual(Number(out.granted_cells), 0, 'blocked request should grant zero cells');
  assert.strictEqual(String(out.reason || ''), 'budget_autopause_active', 'blocked reason should report autopause');

  console.log('spawn_broker.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`spawn_broker.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

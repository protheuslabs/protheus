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

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function writeHealthSnapshot(stateDir, records) {
  const now = Date.now();
  const host = {};
  for (const [model, rec] of Object.entries(records || {})) {
    host[model] = {
      model,
      available: true,
      follows_instructions: true,
      latency_ms: 900,
      checked_ms: now,
      ...(rec || {})
    };
  }
  writeJson(path.join(stateDir, 'model_health.json'), {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: { host },
    records: host
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

  const tmpRoot = path.join(__dirname, 'temp_route_task_budget_guard');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  try {
    writeJson(stopPath, {
      engaged: false,
      scopes: [],
      updated_at: new Date().toISOString(),
      actor: 'test',
      reason: 'route_task_budget_guard'
    });

    const configPath = path.join(tmpRoot, 'config', 'agent_routing_rules.json');
    const adaptersPath = path.join(tmpRoot, 'config', 'model_adapters.json');
    const stateDir = path.join(tmpRoot, 'state', 'routing');
    const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
    const budgetDir = path.join(tmpRoot, 'state', 'autonomy', 'daily_budget');
    const budgetEventsPath = path.join(tmpRoot, 'state', 'autonomy', 'budget_events.jsonl');
    const budgetAutopausePath = path.join(tmpRoot, 'state', 'autonomy', 'budget_autopause.json');
    mkDir(runsDir);
    mkDir(budgetDir);

    writeJson(configPath, {
      version: 1,
      routing: {
        default_anchor_model: 'ollama/kimi-k2.5:cloud',
        spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
        model_profiles: {
          'ollama/smallthinker': { tiers: [1, 2], roles: ['chat', 'general'], class: 'cheap_local' },
          'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['chat', 'general'], class: 'cloud_anchor' }
        },
        communication_fast_path: { enabled: false },
        router_budget_policy: {
          enabled: true,
          allow_strategy_override: false,
          state_dir: budgetDir,
          soft_ratio: 0.75,
          hard_ratio: 0.92
        },
        slot_selection: [
          {
            when: { risk: 'low', complexity: ['low', 'medium'] },
            use_slot: 'grunt',
            prefer_model: 'ollama/smallthinker',
            fallback_slot: 'fallback'
          }
        ]
      }
    });
    writeJson(adaptersPath, { mode_routing: {} });
    writeHealthSnapshot(stateDir, {
      'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 800 }
    });
    writeJson(budgetAutopausePath, {
      schema_id: 'system_budget_autopause',
      schema_version: '1.0.0',
      active: true,
      set_ts: new Date().toISOString(),
      source: 'route_task_budget_guard.test',
      reason: 'manual_pause',
      pressure: 'hard',
      date: todayStr(),
      until_ms: Date.now() + (60 * 60 * 1000),
      until: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
      cleared_ts: null,
      clear_reason: null,
      updated_at: new Date().toISOString()
    });

    const script = path.join(repoRoot, 'systems', 'routing', 'route_task.js');
    const env = {
      ...process.env,
      ROUTER_ENABLED: '1',
      ROUTER_RUNTIME_SCOPE: 'host',
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
      ROUTER_STATE_DIR: stateDir,
      ROUTER_AUTONOMY_RUNS_DIR: runsDir,
      ROUTER_BUDGET_DIR: budgetDir,
      ROUTER_BUDGET_EVENTS_PATH: budgetEventsPath,
      ROUTER_BUDGET_AUTOPAUSE_PATH: budgetAutopausePath,
      ROUTER_BUDGET_TODAY: todayStr()
    };
    const r = spawnSync('node', [
      script,
      '--task', 'quick status ping',
      '--tokens_est', '120',
      '--repeats_14d', '0',
      '--errors_30d', '0',
      '--execution_intent', '1'
    ], { cwd: repoRoot, encoding: 'utf8', env });

    assert.strictEqual(r.status, 0, `route_task should exit 0 when budget blocks: ${r.stderr}`);
    const out = parseJson(r.stdout);
    assert.strictEqual(out.decision, 'MANUAL');
    assert.strictEqual(out.route_budget_blocked, true);
    assert.ok(String(out.reason || '').includes('Router budget guard blocked execution'));
    assert.ok(out.route && out.route.budget_enforcement && out.route.budget_enforcement.blocked === true);

    console.log('route_task_budget_guard.test.js: OK');
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
  console.error(`route_task_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
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

function runNode(repoRoot, args, env) {
  return spawnSync('node', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function makeEnv(cfgPath, adaptersPath, stateDir, runsDir, budgetDir) {
  return {
    ...process.env,
    ROUTER_RUNTIME_SCOPE: 'host',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_BUDGET_DIR: budgetDir,
    ROUTER_BUDGET_TODAY: new Date().toISOString().slice(0, 10),
    ROUTER_PROBE_TTL_MS: '3600000'
  };
}

function baseConfig({ stateDir, variantGainRequired }) {
  return {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: [
        'ollama/kimi-k2.5:cloud',
        'ollama/kimi-k2.5:thinking'
      ],
      model_profiles: {
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['planning', 'logic', 'general'], class: 'cloud_anchor' },
        'ollama/kimi-k2.5:thinking': { tiers: [3], roles: ['planning', 'logic', 'general'], class: 'cloud_specialist' }
      },
      slot_selection: [
        {
          when: { risk: 'high', complexity: 'high' },
          use_slot: 'master',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'master'
        },
        {
          when: { risk: 'low', complexity: ['low', 'medium'] },
          use_slot: 'grunt',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'fallback'
        }
      ],
      communication_fast_path: { enabled: false },
      router_budget_policy: { enabled: false },
      local_hardware_planner: {
        enabled: true,
        activate_recommended_locals: true,
        class_thresholds: [
          { id: 'tiny', max_ram_gb: 8, max_cpu_threads: 4 },
          { id: 'small', max_ram_gb: 16, max_cpu_threads: 8 },
          { id: 'medium', max_ram_gb: 32, max_cpu_threads: 16 },
          { id: 'large' }
        ],
        local_model_requirements: {}
      },
      model_variant_policy: {
        enabled: true,
        min_tier: 3,
        roles: ['logic', 'planning'],
        require_outcome_score_gain: variantGainRequired,
        min_outcome_score_delta: 2,
        max_negative_score_delta: -100,
        auto_return_to_base: true,
        variants: {
          'ollama/kimi-k2.5:cloud': 'ollama/kimi-k2.5:thinking'
        }
      }
    }
  };
}

function caseAppliesVariantOnHighTier(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);

  writeJson(cfgPath, baseConfig({ stateDir, variantGainRequired: false }));
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {});

  const env = makeEnv(cfgPath, adaptersPath, stateDir, runsDir, budgetDir);
  const r = runNode(repoRoot, ['-e', `
    const router = require('./systems/routing/model_router.js');
    const out = router.routeDecision({
      risk: 'high',
      complexity: 'high',
      intent: 'evaluate architectural risk',
      task: 'perform deep analysis with rollback guard',
      mode: 'deep-thinker'
    });
    process.stdout.write(JSON.stringify(out));
  `], env);

  assert.strictEqual(r.status, 0, `high-tier variant case failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.selected_model, 'ollama/kimi-k2.5:thinking', 'high-tier logic task should switch to thinking variant');
  assert.strictEqual(out.variant_routing && out.variant_routing.applied, true, 'variant should be marked applied');
  assert.strictEqual(out.post_task_return_model, 'ollama/kimi-k2.5:cloud', 'route should request return to base model after variant task');
}

function caseSkipsVariantWhenGainMissing(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);

  writeJson(cfgPath, baseConfig({ stateDir, variantGainRequired: true }));
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {});

  const day = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({
      ts: `${day}T05:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'role:logic',
      route_summary: { selected_model: 'ollama/kimi-k2.5:cloud', route_role: 'logic' },
      verification: { passed: true },
      outcome: 'shipped'
    });
    rows.push({
      ts: `${day}T06:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'role:logic',
      route_summary: { selected_model: 'ollama/kimi-k2.5:thinking', route_role: 'logic' },
      verification: { passed: false },
      outcome: 'no_change'
    });
  }
  writeJsonl(path.join(runsDir, `${day}.jsonl`), rows);

  const env = makeEnv(cfgPath, adaptersPath, stateDir, runsDir, budgetDir);
  const r = runNode(repoRoot, ['-e', `
    const router = require('./systems/routing/model_router.js');
    const out = router.routeDecision({
      risk: 'high',
      complexity: 'high',
      intent: 'evaluate architectural risk',
      task: 'perform deep analysis with rollback guard',
      mode: 'deep-thinker'
    });
    process.stdout.write(JSON.stringify(out));
  `], env);

  assert.strictEqual(r.status, 0, `variant gain gate case failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.selected_model, 'ollama/kimi-k2.5:cloud', 'router should keep base model when variant gain threshold is not met');
  assert.strictEqual(out.variant_routing && out.variant_routing.applied, false, 'variant should not be applied when gain threshold fails');
  assert.strictEqual(out.variant_routing && out.variant_routing.reason, 'variant_outcome_gain_not_met', 'router should expose outcome gain gate reason');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_model_router_variant_policy');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  caseAppliesVariantOnHighTier(repoRoot, path.join(tmpRoot, 'case_high_tier'));
  caseSkipsVariantWhenGainMissing(repoRoot, path.join(tmpRoot, 'case_gain_gate'));

  console.log('model_router_variant_policy.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`model_router_variant_policy.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function buildConfig({ stateDir }) {
  return {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: [
        'ollama/smallthinker',
        'ollama/qwen3:4b',
        'ollama/kimi-k2.5:cloud'
      ],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1], roles: ['chat', 'general'], class: 'cheap_local' },
        'ollama/qwen3:4b': { tiers: [1, 2], roles: ['coding', 'tools', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [1, 2, 3], roles: ['chat', 'planning', 'general'], class: 'cloud_anchor' }
      },
      slot_selection: [
        {
          when: { risk: 'low', complexity: ['low', 'medium'] },
          use_slot: 'grunt',
          prefer_model: 'ollama/qwen3:4b',
          fallback_slot: 'fallback'
        }
      ],
      communication_fast_path: { enabled: false },
      router_budget_policy: { enabled: false },
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      },
      local_hardware_planner: {
        enabled: true,
        activate_recommended_locals: true,
        class_thresholds: [
          { id: 'tiny', max_ram_gb: 8, max_cpu_threads: 4 },
          { id: 'small', max_ram_gb: 16, max_cpu_threads: 8 },
          { id: 'medium', max_ram_gb: 32, max_cpu_threads: 16 },
          { id: 'large' }
        ],
        local_model_requirements: {
          'ollama/smallthinker': { min_hardware_class: 'small', min_ram_gb: 12, min_cpu_threads: 6 },
          'ollama/qwen3:4b': { min_hardware_class: 'small', min_ram_gb: 12, min_cpu_threads: 6 }
        }
      }
    }
  };
}

function baseEnv(cfgPath, adaptersPath, stateDir, runsDir) {
  return {
    ...process.env,
    ROUTER_RUNTIME_SCOPE: 'host',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_PROBE_TTL_MS: '3600000',
    ROUTER_RAM_GB: '8',
    ROUTER_CPU_THREADS: '4',
    ROUTER_HW_CLASS: 'tiny'
  };
}

function caseRouteFiltersLocal(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  mkDir(runsDir);

  writeJson(cfgPath, buildConfig({ stateDir }));
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true },
    'ollama/qwen3:4b': { available: true }
  });

  const env = baseEnv(cfgPath, adaptersPath, stateDir, runsDir);
  const r = runNode(repoRoot, ['-e', `
    const router = require('./systems/routing/model_router.js');
    const out = router.routeDecision({
      risk: 'low',
      complexity: 'low',
      intent: 'quick summary',
      task: 'summarize latest status',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify(out));
  `], env);

  assert.strictEqual(r.status, 0, `routeDecision failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.selected_model, 'ollama/kimi-k2.5:cloud', 'cloud anchor should be selected when local models are hardware-ineligible');
  assert.strictEqual(out.hardware_plan && out.hardware_plan.active_filter, true, 'hardware filter should be active');
  assert.strictEqual(Array.isArray(out.hardware_plan.effective_local_models), true, 'hardware plan should include effective locals array');
  assert.strictEqual(out.hardware_plan.effective_local_models.length, 0, 'no local models should be eligible on tiny profile');
}

function caseDoctorAndCacheSurfaceHardwareReasons(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  mkDir(runsDir);

  writeJson(cfgPath, buildConfig({ stateDir }));
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true },
    'ollama/qwen3:4b': { available: true }
  });

  const env = baseEnv(cfgPath, adaptersPath, stateDir, runsDir);

  const doctor = runNode(repoRoot, [
    'systems/routing/model_router.js',
    'doctor',
    '--risk=low',
    '--complexity=low',
    '--intent=health',
    '--task=health check'
  ], env);
  assert.strictEqual(doctor.status, 0, `doctor failed: ${doctor.stderr}`);
  const doctorOut = JSON.parse(String(doctor.stdout || '{}'));
  const qwenDiag = (doctorOut.diagnostics || []).find((d) => d.model === 'ollama/qwen3:4b');
  assert.ok(qwenDiag, 'doctor output should include qwen diagnostics');
  assert.ok((qwenDiag.reasons || []).includes('local_hardware_ineligible'), 'doctor should flag local_hardware_ineligible');
  assert.strictEqual(doctorOut.policy && doctorOut.policy.hardware_plan && doctorOut.policy.hardware_plan.active_filter, true, 'doctor policy should expose active hardware filter');

  const cache = runNode(repoRoot, [
    'systems/routing/model_router.js',
    'cache-summary',
    '--for-routing=1',
    '--risk=low',
    '--complexity=low',
    '--intent=health',
    '--task=cache summary'
  ], env);
  assert.strictEqual(cache.status, 0, `cache-summary failed: ${cache.stderr}`);
  const cacheOut = JSON.parse(String(cache.stdout || '{}'));
  const qwenRow = (cacheOut.results || []).find((row) => row.model === 'ollama/qwen3:4b');
  assert.ok(qwenRow, 'cache-summary should include qwen row');
  assert.strictEqual(qwenRow.hardware_allowed, false, 'cache-summary should mark hardware_allowed=false');
  assert.ok((qwenRow.reasons || []).includes('local_hardware_ineligible'), 'cache-summary should include local_hardware_ineligible reason');
  assert.strictEqual(cacheOut.hardware_plan && cacheOut.hardware_plan.active_filter, true, 'cache-summary should include hardware plan summary');

  const plan = runNode(repoRoot, ['systems/routing/model_router.js', 'hardware-plan'], env);
  assert.strictEqual(plan.status, 0, `hardware-plan failed: ${plan.stderr}`);
  const planOut = JSON.parse(String(plan.stdout || '{}'));
  assert.strictEqual(planOut.type, 'hardware_plan', 'hardware-plan command should emit typed payload');
  assert.strictEqual(planOut.profile && planOut.profile.hardware_class, 'tiny', 'hardware-plan should reflect forced tiny hardware class');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_model_router_hardware_planner');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  caseRouteFiltersLocal(repoRoot, path.join(tmpRoot, 'case_route'));
  caseDoctorAndCacheSurfaceHardwareReasons(repoRoot, path.join(tmpRoot, 'case_reports'));

  console.log('model_router_hardware_planner.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`model_router_hardware_planner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

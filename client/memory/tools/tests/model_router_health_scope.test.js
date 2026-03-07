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

function runNodeEval(repoRoot, code, env) {
  return spawnSync('node', ['-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function makeRoutingConfig() {
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
        'ollama/qwen3:4b': { tiers: [1, 2], roles: ['coding', 'tools', 'logic', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['planning', 'logic', 'chat', 'general'], class: 'cloud_anchor' }
      },
      slot_selection: [
        {
          when: { risk: 'low', complexity: ['low', 'medium'] },
          use_slot: 'grunt',
          prefer_model: 'ollama/smallthinker',
          fallback_slot: 'fallback'
        }
      ],
      local_probe_policy: {
        default: {
          timeout_ms: 8000,
          max_latency_ms: 6000,
          accept_ok_token: true
        }
      }
    }
  };
}

function makeModeAdapters() {
  // Keep empty so mode adjustments do not overwrite explicit risk/complexity in tests.
  return { mode_routing: {} };
}

function testHostPriorityForRouting(repoRoot, tmpRoot) {
  const cfgPath = path.join(tmpRoot, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(tmpRoot, 'config', 'model_adapters.json');
  const stateDir = path.join(tmpRoot, 'state', 'routing');
  const healthPath = path.join(stateDir, 'model_health.json');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');

  writeJson(cfgPath, makeRoutingConfig());
  writeJson(adaptersPath, makeModeAdapters());
  mkDir(runsDir);

  const now = Date.now();
  const hostQwen = {
    model: 'ollama/qwen3:4b',
    available: true,
    follows_instructions: true,
    latency_ms: 1200,
    checked_ms: now
  };
  const sandboxQwen = {
    model: 'ollama/qwen3:4b',
    available: null,
    probe_blocked: true,
    reason: 'env_probe_blocked',
    checked_ms: now
  };
  const sandboxSmall = {
    model: 'ollama/smallthinker',
    available: null,
    probe_blocked: true,
    reason: 'env_probe_blocked',
    checked_ms: now
  };

  writeJson(healthPath, {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: {
      host: {
        'ollama/qwen3:4b': hostQwen
      },
      sandbox: {
        'ollama/qwen3:4b': sandboxQwen,
        'ollama/smallthinker': sandboxSmall
      }
    },
    records: {
      'ollama/qwen3:4b': hostQwen
    }
  });

  const env = {
    ...process.env,
    ROUTER_RUNTIME_SCOPE: 'sandbox',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_PROBE_TTL_MS: '3600000'
  };

  const code = `
    const router = require('./systems/routing/model_router.js');
    const routed = router.health('ollama/qwen3:4b', false, { forRouting: true });
    const local = router.health('ollama/qwen3:4b', false, { forRouting: false });
    const decision = router.routeDecision({ risk: 'low', complexity: 'low', intent: 'test', task: 'test', mode: 'normal' });
    process.stdout.write(JSON.stringify({ routed, local, decision }));
  `;
  const r = runNodeEval(repoRoot, code, env);
  assert.strictEqual(r.status, 0, `host-priority eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));

  assert.strictEqual(out.routed.source_runtime, 'host', 'routing health should prefer host runtime');
  assert.strictEqual(out.routed.available, true, 'routing health should use healthy host record');
  assert.strictEqual(out.local.source_runtime, 'sandbox', 'non-routing health should use current runtime first');
  assert.strictEqual(out.decision.selected_model, 'ollama/qwen3:4b', 'route should select healthy host-local model');
}

function testAtomicPerModelUpdateNoClobber(repoRoot, tmpRoot) {
  const cfgPath = path.join(tmpRoot, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(tmpRoot, 'config', 'model_adapters.json');
  const stateDir = path.join(tmpRoot, 'state', 'routing');
  const healthPath = path.join(stateDir, 'model_health.json');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');

  writeJson(cfgPath, makeRoutingConfig());
  writeJson(adaptersPath, makeModeAdapters());
  mkDir(runsDir);

  const now = Date.now();
  const hostNeedsNormalize = {
    model: 'ollama/qwen3:4b',
    available: false,
    reason: 'exit_1',
    stderr: 'dial tcp 127.0.0.1:11434: connect: operation not permitted',
    checked_ms: now
  };
  const hostKeep = {
    model: 'ollama/gemma3:4b',
    available: true,
    follows_instructions: true,
    latency_ms: 900,
    checked_ms: now,
    marker: 'keep'
  };

  writeJson(healthPath, {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: {
      host: {
        'ollama/qwen3:4b': hostNeedsNormalize,
        'ollama/gemma3:4b': hostKeep
      }
    },
    records: {
      'ollama/qwen3:4b': hostNeedsNormalize,
      'ollama/gemma3:4b': hostKeep
    }
  });

  const env = {
    ...process.env,
    ROUTER_RUNTIME_SCOPE: 'sandbox',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_PROBE_TTL_MS: '3600000'
  };

  const code = `
    const fs = require('fs');
    const path = require('path');
    const router = require('./systems/routing/model_router.js');
    const res = router.health('ollama/qwen3:4b', false, { forRouting: true });
    const healthPath = path.join(process.env.ROUTER_STATE_DIR, 'model_health.json');
    const snapshot = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    process.stdout.write(JSON.stringify({ res, snapshot }));
  `;
  const r = runNodeEval(repoRoot, code, env);
  assert.strictEqual(r.status, 0, `atomic-update eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));

  assert.strictEqual(out.res.source_runtime, 'host');
  assert.strictEqual(out.res.reason, 'env_probe_blocked', 'normalization should mark env_probe_blocked');
  assert.strictEqual(out.res.available, null, 'normalization should set available=null');

  const hostMap = (((out.snapshot || {}).runtimes || {}).host || {});
  assert.ok(hostMap['ollama/gemma3:4b'], 'unrelated model record should remain after update');
  assert.strictEqual(hostMap['ollama/gemma3:4b'].marker, 'keep', 'unrelated model marker should be preserved');
}

function testSuppressedModelReturnsUnavailable(repoRoot, tmpRoot) {
  const cfgPath = path.join(tmpRoot, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(tmpRoot, 'config', 'model_adapters.json');
  const stateDir = path.join(tmpRoot, 'state', 'routing');
  const healthPath = path.join(stateDir, 'model_health.json');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');

  writeJson(cfgPath, makeRoutingConfig());
  writeJson(adaptersPath, makeModeAdapters());
  mkDir(runsDir);

  const now = Date.now();
  const suppressedQwen = {
    model: 'ollama/qwen3:4b',
    available: true,
    follows_instructions: true,
    latency_ms: 1300,
    checked_ms: now,
    suppressed_until_ms: now + (30 * 60 * 1000),
    suppressed_reason: 'timeout_streak',
    timeout_streak: 3
  };

  writeJson(healthPath, {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: {
      host: {
        'ollama/qwen3:4b': suppressedQwen
      }
    },
    records: {
      'ollama/qwen3:4b': suppressedQwen
    }
  });

  const env = {
    ...process.env,
    ROUTER_RUNTIME_SCOPE: 'host',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_PROBE_TTL_MS: '3600000'
  };

  const code = `
    const router = require('./systems/routing/model_router.js');
    const routed = router.health('ollama/qwen3:4b', false, { forRouting: true });
    process.stdout.write(JSON.stringify({ routed }));
  `;
  const r = runNodeEval(repoRoot, code, env);
  assert.strictEqual(r.status, 0, `suppression eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.routed.available, false, 'suppressed model should be unavailable during suppression window');
  assert.strictEqual(out.routed.reason, 'probe_suppressed_timeout_rehab', 'suppressed model should surface suppression reason');
  assert.strictEqual(out.routed.suppressed, true, 'suppressed marker should be set');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_model_router_health_scope');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  testHostPriorityForRouting(repoRoot, path.join(tmpRoot, 'case_host_priority'));
  testAtomicPerModelUpdateNoClobber(repoRoot, path.join(tmpRoot, 'case_atomic'));
  testSuppressedModelReturnsUnavailable(repoRoot, path.join(tmpRoot, 'case_suppressed'));

  console.log('model_router_health_scope.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`model_router_health_scope.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

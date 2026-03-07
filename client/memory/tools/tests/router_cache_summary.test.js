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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_router_cache_summary');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const cfgPath = path.join(tmpRoot, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(tmpRoot, 'config', 'model_adapters.json');
  const stateDir = path.join(tmpRoot, 'state', 'routing');
  const healthPath = path.join(stateDir, 'model_health.json');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  mkDir(runsDir);

  writeJson(cfgPath, {
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
        'ollama/qwen3:4b': { tiers: [1, 2], roles: ['coding', 'tools', 'logic', 'general'], class: 'cheap_local' }
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
        default: { timeout_ms: 10000, max_latency_ms: 8000, accept_ok_token: true },
        models: {
          'ollama/qwen3:4b': { max_latency_ms: 10000 }
        }
      }
    }
  });

  writeJson(adaptersPath, { mode_routing: {} });

  const now = Date.now();
  writeJson(healthPath, {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: {
      host: {
        'ollama/qwen3:4b': {
          model: 'ollama/qwen3:4b',
          available: true,
          follows_instructions: true,
          latency_ms: 1200,
          checked_ms: now
        }
      },
      sandbox: {
        'ollama/qwen3:4b': {
          model: 'ollama/qwen3:4b',
          available: null,
          probe_blocked: true,
          reason: 'env_probe_blocked',
          checked_ms: now
        },
        'ollama/smallthinker': {
          model: 'ollama/smallthinker',
          available: null,
          probe_blocked: true,
          reason: 'env_probe_blocked',
          checked_ms: now
        }
      }
    },
    records: {
      'ollama/qwen3:4b': {
        model: 'ollama/qwen3:4b',
        available: true,
        follows_instructions: true,
        latency_ms: 1200,
        checked_ms: now
      }
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

  const r = spawnSync(
    'node',
    [
      'client/systems/routing/model_router.js',
      'cache-summary',
      '--for-routing=1',
      '--risk=low',
      '--complexity=low',
      '--intent=spine_preflight',
      '--task=cache-only routing summary'
    ],
    { cwd: repoRoot, encoding: 'utf8', env }
  );

  assert.strictEqual(r.status, 0, `cache-summary should pass: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.type, 'cache_summary');
  assert.strictEqual(out.for_routing, true);
  assert.strictEqual(out.local_total, 2);
  assert.ok(Number(out.local_eligible || 0) >= 1, 'local_eligible should be >= 1 with healthy host cache');
  const isFullLocalDown = out.local_total > 0 && out.local_eligible === 0;
  assert.strictEqual(isFullLocalDown, false, 'sandbox blocked + healthy host cache must not report full local down');
  assert.ok(Number((out.source_runtime_counts || {}).host || 0) >= 1, 'host runtime should contribute cache entries');
  assert.strictEqual(out.tier1_local_decision.local_best, 'ollama/qwen3:4b');
  assert.strictEqual(out.tier1_local_decision.escalate, false);

  console.log('router_cache_summary.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`router_cache_summary.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


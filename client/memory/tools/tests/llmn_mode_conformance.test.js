#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ROUTER_PATH = [
  path.join(ROOT, 'runtime', 'systems', 'routing', 'model_router.js'),
  path.join(ROOT, 'systems', 'routing', 'model_router.js')
].find((candidate) => fs.existsSync(candidate));

if (!ROUTER_PATH) {
  throw new Error('model_router_missing');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildMinimalRoutingConfig(configPath) {
  writeJson(configPath, {
    routing: {
      spawn_model_allowlist: ['openai/gpt-4o-mini'],
      slot_selection: [
        {
          when: {},
          prefer_model: 'openai/gpt-4o-mini',
          fallback_slot: 'fallback'
        }
      ],
      model_variant_policy: { enabled: false },
      prompt_cache: { enabled: false },
      route_classes: {}
    }
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmn-conformance-'));
const configPath = path.join(tempRoot, 'config', 'agent_routing_rules.json');
const stateDir = path.join(tempRoot, 'state', 'routing');
const autonomyRunsDir = path.join(tempRoot, 'state', 'autonomy', 'runs');

buildMinimalRoutingConfig(configPath);

const previousEnv = {
  ROUTER_CONFIG_PATH: process.env.ROUTER_CONFIG_PATH,
  ROUTER_STATE_DIR: process.env.ROUTER_STATE_DIR,
  ROUTER_AUTONOMY_RUNS_DIR: process.env.ROUTER_AUTONOMY_RUNS_DIR,
  ROUTER_MODE_ADAPTERS_PATH: process.env.ROUTER_MODE_ADAPTERS_PATH
};

process.env.ROUTER_CONFIG_PATH = configPath;
process.env.ROUTER_STATE_DIR = stateDir;
process.env.ROUTER_AUTONOMY_RUNS_DIR = autonomyRunsDir;
process.env.ROUTER_MODE_ADAPTERS_PATH = path.join(ROOT, 'runtime', 'config', 'model_adapters.json');

let router = null;
try {
  router = require(ROUTER_PATH);
  assert.ok(typeof router.normalizeLllmMode === 'function', 'normalizeLllmMode export is required');

  const normalizationCases = [
    ['standard', 'normal'],
    ['default', 'normal'],
    ['creative', 'creative'],
    ['narrative', 'narrative'],
    ['hyper creative', 'hyper-creative'],
    ['hyper_creative', 'hyper-creative'],
    ['deep thinking', 'deep-thinker'],
    ['deep_thinking', 'deep-thinker']
  ];
  for (const [input, expected] of normalizationCases) {
    assert.strictEqual(router.normalizeLllmMode(input), expected, `mode alias mismatch: ${input}`);
  }

  const routeCases = [
    ['standard', 'normal'],
    ['creative', 'creative'],
    ['narrative', 'narrative'],
    ['hyper creative', 'hyper-creative'],
    ['deep thinking', 'deep-thinker']
  ];

  for (const [inputMode, canonical] of routeCases) {
    const out = router.routeDecision({
      risk: 'low',
      complexity: 'low',
      intent: 'status update',
      task: 'reply with summary',
      mode: inputMode,
      tokensEst: 180
    });
    assert.ok(out && out.type === 'route', `routeDecision should return route payload for mode=${inputMode}`);
    assert.strictEqual(out.mode, canonical, `routeDecision should normalize mode=${inputMode} to ${canonical}`);
    assert.ok(out.selected_model, `routeDecision should select a model for mode=${inputMode}`);
  }

  console.log('llmn_mode_conformance.test.js: OK');
} catch (err) {
  console.error(`llmn_mode_conformance.test.js: FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

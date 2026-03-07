#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'model_health_auto_recovery.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, body) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected JSON stdout');
  return JSON.parse(txt);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-autorecovery-'));
  const stateDir = path.join(tmp, 'state');
  const configDir = path.join(tmp, 'config');
  const routingConfigPath = path.join(configDir, 'agent_routing_rules.json');
  const policyPath = path.join(configDir, 'model_health_auto_recovery_policy.json');
  const providerScriptPath = path.join(tmp, 'provider_stub.js');
  const routerScriptPath = path.join(tmp, 'router_stub.js');
  const bansPath = path.join(stateDir, 'routing', 'banned_models.json');
  const decisionsPath = path.join(stateDir, 'routing', 'routing_decisions.jsonl');
  const runDate = '2026-02-26';

  writeJson(routingConfigPath, {
    version: 1,
    routing: {
      spawn_model_allowlist: [
        'ollama/smallthinker',
        'ollama/gemma3:4b',
        'gpt-oss:120b-cloud'
      ]
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    providers: ['ollama'],
    max_retries_per_provider: 2,
    retry_backoff_ms: [0, 0],
    ban_ttl_minutes: 60,
    warmup_on_failure: true,
    warmup_max_probes: 1,
    failover_route: {
      enabled: true,
      risk: 'low',
      complexity: 'low',
      intent_template: 'autorecovery_{provider}',
      task_template: 'provider_{provider}_down'
    }
  });

  writeText(providerScriptPath, `#!/usr/bin/env node
const mode = String(process.env.PROVIDER_STUB_MODE || 'down').trim();
const available = mode === 'up';
console.log(JSON.stringify({
  ok: true,
  provider: 'ollama',
  available,
  reason: available ? 'ok' : 'provider_unavailable',
  status: available ? 'up' : 'down',
  circuit_open: !available
}));
`);
  fs.chmodSync(providerScriptPath, 0o755);

  writeText(routerScriptPath, `#!/usr/bin/env node
const cmd = String(process.argv[2] || '');
if (cmd === 'warmup') {
  console.log(JSON.stringify({ ok: true, warmed_count: 1, recovered_count: 0, skipped_reason: null }));
  process.exit(0);
}
if (cmd === 'route') {
  const selected = String(process.env.ROUTER_STUB_SELECTED_MODEL || 'gpt-oss:120b-cloud');
  console.log(JSON.stringify({ ok: true, selected_model: selected, reason: 'stub_route' }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, error: 'unknown_command', cmd }));
process.exit(2);
`);
  fs.chmodSync(routerScriptPath, 0o755);

  const baseEnv = {
    MODEL_HEALTH_AUTORECOVERY_POLICY_PATH: policyPath,
    MODEL_HEALTH_AUTORECOVERY_STATE_DIR: path.join(stateDir, 'routing', 'model_health_auto_recovery'),
    MODEL_HEALTH_AUTORECOVERY_ROUTING_CONFIG_PATH: routingConfigPath,
    MODEL_HEALTH_AUTORECOVERY_PROVIDER_SCRIPT: providerScriptPath,
    MODEL_HEALTH_AUTORECOVERY_ROUTER_SCRIPT: routerScriptPath,
    MODEL_HEALTH_AUTORECOVERY_BANS_PATH: bansPath,
    MODEL_HEALTH_AUTORECOVERY_DECISIONS_PATH: decisionsPath
  };

  const downRun = run(['run', runDate], {
    ...baseEnv,
    PROVIDER_STUB_MODE: 'down',
    ROUTER_STUB_SELECTED_MODEL: 'gpt-oss:120b-cloud'
  });
  assert.strictEqual(downRun.status, 0, `down run should pass: ${downRun.stderr}`);
  const downPayload = parseJson(downRun.stdout);
  assert.strictEqual(downPayload.ok, true, 'down payload should be ok');
  assert.strictEqual(Number(downPayload.providers_healthy), 0, 'provider should be unhealthy');
  assert.ok(Array.isArray(downPayload.providers) && downPayload.providers.length === 1, 'single provider row expected');
  assert.strictEqual(downPayload.providers[0].failover.applied, true, 'failover should be applied to non-ollama model');
  assert.ok(Number(downPayload.providers[0].auto_bans_applied || 0) >= 1, 'auto bans should be applied');

  const bansAfterDown = JSON.parse(fs.readFileSync(bansPath, 'utf8'));
  const bannedModels = Object.keys(bansAfterDown || {});
  assert.ok(bannedModels.includes('ollama/smallthinker'), 'local ollama model should be auto-banned');
  assert.ok(String(bansAfterDown['ollama/smallthinker'].reason || '').includes('provider_ollama_down_auto_recovery'), 'ban reason should include autorecovery prefix');

  const upRun = run(['run', '2026-02-27'], {
    ...baseEnv,
    PROVIDER_STUB_MODE: 'up',
    ROUTER_STUB_SELECTED_MODEL: 'gpt-oss:120b-cloud'
  });
  assert.strictEqual(upRun.status, 0, `up run should pass: ${upRun.stderr}`);
  const upPayload = parseJson(upRun.stdout);
  assert.strictEqual(Number(upPayload.providers_healthy), 1, 'provider should recover');
  assert.ok(Number(upPayload.providers[0].auto_bans_cleared || 0) >= 1, 'auto bans should clear when provider recovers');

  const bansAfterUp = JSON.parse(fs.readFileSync(bansPath, 'utf8'));
  assert.strictEqual(Object.keys(bansAfterUp).length, 0, 'no autorecovery bans should remain after recovery');

  console.log('model_health_auto_recovery.test.js: OK');
} catch (err) {
  console.error(`model_health_auto_recovery.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

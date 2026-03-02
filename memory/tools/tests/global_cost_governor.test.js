#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'budget', 'global_cost_governor.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-cost-governor-'));
  const policyPath = path.join(tmp, 'config', 'global_cost_governor_policy.json');
  const usagePath = path.join(tmp, 'state', 'budget', 'global_cost_governor', 'usage.json');
  const autopausePath = path.join(tmp, 'state', 'autonomy', 'budget_autopause.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    modules: ['autonomy', 'reflex', 'focus', 'dream', 'spawn'],
    module_daily_token_caps: {
      autonomy: 1000,
      reflex: 400,
      focus: 400,
      dream: 400,
      spawn: 400
    },
    daily_token_cap_total: 1500,
    monthly_token_cap_total: 3000,
    burn_rate_multiplier: 2,
    min_baseline_days: 1,
    auto_clear_autopause: true,
    state_paths: {
      usage_path: usagePath,
      autopause_path: autopausePath,
      latest_path: path.join(tmp, 'state', 'budget', 'global_cost_governor', 'latest.json'),
      history_path: path.join(tmp, 'state', 'budget', 'global_cost_governor', 'history.jsonl')
    }
  });

  writeJson(usagePath, {
    schema_id: 'global_cost_governor_usage',
    version: 1,
    updated_at: null,
    by_day: {
      '2026-03-01': { autonomy: 300, reflex: 50, focus: 50, dream: 50, spawn: 50 }
    }
  });

  const env = {
    GLOBAL_COST_GOVERNOR_ROOT: tmp,
    GLOBAL_COST_GOVERNOR_POLICY_PATH: policyPath
  };

  let r = run(['evaluate', '--module=autonomy', '--tokens=1200', '--date=2026-03-02', '--apply=1', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'module cap breach should fail strict evaluate');
  let out = parseJson(r.stdout);
  assert.ok(out && out.hard_stop === true, 'payload should hard-stop');
  assert.ok(Array.isArray(out.blockers) && out.blockers.some((b) => b.gate === 'module_cap'));
  const autopause = readJson(autopausePath);
  assert.strictEqual(autopause.active, true, 'hard-stop should engage autopause');

  r = run(['evaluate', '--module=autonomy', '--tokens=10', '--date=2026-03-03', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'safe evaluate should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'safe payload should pass');
  const autopauseCleared = readJson(autopausePath);
  assert.strictEqual(autopauseCleared.active, false, 'safe window should auto-clear autopause');

  r = run(['status', '--date=2026-03-03'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'status should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status payload should be ok');

  console.log('global_cost_governor.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`global_cost_governor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

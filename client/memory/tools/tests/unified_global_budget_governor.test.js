#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'budget', 'unified_global_budget_governor.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-budget-'));
  const policyPath = path.join(tmp, 'config', 'unified_global_budget_governor_policy.json');
  const autopausePath = path.join(tmp, 'state', 'autonomy', 'budget_autopause.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    modules: ['reflex', 'autonomy', 'focus', 'dream', 'spawn'],
    module_daily_caps: {
      reflex: 400,
      autonomy: 500,
      focus: 400,
      dream: 400,
      spawn: 400
    },
    daily_token_cap_total: 1000,
    contention: {
      degrade_at_ratio: 0.85,
      deny_at_ratio: 1.0
    },
    outputs: {
      state_path: path.join(tmp, 'state', 'budget', 'state.json'),
      decisions_path: path.join(tmp, 'state', 'budget', 'decisions.jsonl'),
      latest_path: path.join(tmp, 'state', 'budget', 'latest.json'),
      history_path: path.join(tmp, 'state', 'budget', 'history.jsonl'),
      autopause_path: autopausePath
    }
  });

  const env = {
    UNIFIED_BUDGET_GOVERNOR_ROOT: tmp,
    UNIFIED_BUDGET_GOVERNOR_POLICY_PATH: policyPath
  };

  let r = run(['evaluate', '--module=autonomy', '--tokens=400', '--date=2026-03-02', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'autonomy allow should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.decision === 'allow', 'first decision should allow');

  r = run(['evaluate', '--module=dream', '--tokens=450', '--date=2026-03-02', '--apply=1', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'dream module cap breach should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.decision === 'deny', 'dream over cap should deny');

  r = run(['evaluate', '--module=focus', '--tokens=450', '--date=2026-03-02', '--apply=1', '--strict=0'], env);
  assert.notStrictEqual(r.status, 0, 'global cap deny should still fail process exit');
  out = parseJson(r.stdout);
  assert.ok(out && out.decision === 'deny', 'global cap deny should trigger');

  const autopause = readJson(autopausePath);
  assert.strictEqual(autopause.active, true, 'deny should activate autopause');

  r = run(['status', '--date=2026-03-02'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'status should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status payload should be ok');
  assert.ok(out.usage && Number(out.usage.autonomy || 0) === 400, 'status should keep allowed usage');

  console.log('unified_global_budget_governor.test.js: OK');
}

try { main(); } catch (err) { console.error(`unified_global_budget_governor.test.js: FAIL: ${err.message}`); process.exit(1); }

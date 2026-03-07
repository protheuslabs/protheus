#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function run(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { cwd, env, encoding: 'utf8' });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'proactive_t1_initiative_engine.js');
  const zplPolicyPath = path.join(root, 'config', 'zero_permission_conversational_layer_policy.json');
  const symPolicyPath = path.join(root, 'config', 'deep_symbiosis_understanding_layer_policy.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-t1-'));
  const policyPath = path.join(tmp, 'policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    auto_generate_from_context: false,
    min_tick_interval_sec: 0,
    max_initiatives_per_tick: 3,
    objective_id: 'T1_make_jay_billionaire_v1',
    auto_execute_risk_tiers: ['low', 'medium'],
    state: {
      state_path: path.join(tmp, 'state.json'),
      queue_path: path.join(tmp, 'queue.jsonl'),
      latest_path: path.join(tmp, 'latest.json'),
      receipts_path: path.join(tmp, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    PROACTIVE_T1_INITIATIVE_ENGINE_POLICY_PATH: policyPath,
    ZERO_PERMISSION_CONVERSATIONAL_LAYER_POLICY_PATH: zplPolicyPath,
    DEEP_SYMBIOSIS_UNDERSTANDING_POLICY_PATH: symPolicyPath
  };

  let out = run(scriptPath, [
    'enqueue',
    '--initiative-json={"initiative_id":"i1","kind":"noop","risk_tier":"low","estimated_cost_usd":0,"liability_score":0.05}'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'enqueue should pass');

  out = run(scriptPath, ['tick', '--source=test_suite'], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'tick should pass');
  assert.ok(out.payload && out.payload.ok === true, 'tick payload should be ok');
  assert.strictEqual(Number(out.payload.executed_count || 0), 1, 'one initiative should execute');
  assert.strictEqual(Number(out.payload.escalated_count || 0), 0, 'no escalation expected');

  out = run(scriptPath, ['status'], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  assert.ok(out.payload && out.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Number(out.payload.state.executed_total || 0), 1, 'state executed total should be 1');

  console.log('proactive_t1_initiative_engine.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`proactive_t1_initiative_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
  const scriptPath = path.join(root, 'systems', 'autonomy', 'zero_permission_conversational_layer.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpl-'));
  const policyPath = path.join(tmp, 'policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    high_risk_min_approval_note_chars: 12,
    medium_veto_window_minutes: 1,
    threshold_usd: { low: 100, medium: 1000 },
    liability_threshold: { low: 0.2, medium: 0.55 },
    state: {
      state_path: path.join(tmp, 'state.json'),
      latest_path: path.join(tmp, 'latest.json'),
      receipts_path: path.join(tmp, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    ZERO_PERMISSION_CONVERSATIONAL_LAYER_POLICY_PATH: policyPath
  };

  let out = run(scriptPath, [
    'decide',
    '--action-id=low_case',
    '--risk-tier=low',
    '--estimated-cost-usd=20',
    '--liability-score=0.1',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'low decide should pass');
  assert.ok(out.payload && out.payload.ok === true, 'low payload should be ok');
  assert.strictEqual(String(out.payload.execution_mode || ''), 'execute_and_report', 'low should execute and report');
  assert.strictEqual(Boolean(out.payload.operator_prompt_required), false, 'low should not prompt operator');

  out = run(scriptPath, [
    'decide',
    '--action-id=med_case',
    '--estimated-cost-usd=250',
    '--liability-score=0.3',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'medium decide should pass');
  assert.strictEqual(String(out.payload.risk_tier || ''), 'medium', 'medium inferred');
  assert.strictEqual(String(out.payload.execution_mode || ''), 'shadow_then_auto_execute_unless_vetoed', 'medium mode');

  out = run(scriptPath, [
    'decide',
    '--action-id=high_case',
    '--risk-tier=high',
    '--estimated-cost-usd=5000',
    '--liability-score=0.9',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'high decide should pass');
  assert.strictEqual(String(out.payload.execution_mode || ''), 'explicit_approval_required', 'high mode');
  assert.strictEqual(Boolean(out.payload.operator_prompt_required), true, 'high should prompt operator');
  assert.ok(Array.isArray(out.payload.reason_codes) && out.payload.reason_codes.includes('high_risk_apply_required'), 'high should require apply');

  console.log('zero_permission_conversational_layer.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`zero_permission_conversational_layer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

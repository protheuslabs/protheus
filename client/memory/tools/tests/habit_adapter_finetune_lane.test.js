#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'assimilation', 'habit_adapter_finetune_lane.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(policyPath, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HABIT_ADAPTER_FINETUNE_POLICY_PATH: policyPath
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-finetune-'));
  const policyPath = path.join(tmp, 'config', 'habit_adapter_finetune_policy.json');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      adapters_path: path.join(tmp, 'state', 'adapters.json')
    }
  });

  let res = run(policyPath, ['train', '--habit=sales', '--objective=retention', '--uplift=0.2']);
  assert.strictEqual(res.status, 0, `train should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'habit_adapter_finetune_train');
  assert.strictEqual(res.payload.status, 'promote_candidate');

  res = run(policyPath, ['status']);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'habit_adapter_finetune_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('habit_adapter_finetune_lane.test.js: OK');
} catch (err) {
  console.error(`habit_adapter_finetune_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

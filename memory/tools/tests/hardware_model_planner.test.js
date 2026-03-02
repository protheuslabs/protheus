#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'routing', 'hardware_model_planner.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-model-planner-'));
  const policyPath = path.join(tmp, 'config', 'hardware_model_planner_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    tiers: {
      nano: { max_threads: 8, max_ram_gb: 12, max_vram_gb: 4, recommended_models: ['nano-model'] },
      standard: { max_threads: 24, max_ram_gb: 48, max_vram_gb: 16, recommended_models: ['std-model'] },
      high: { max_threads: 256, max_ram_gb: 4096, max_vram_gb: 512, recommended_models: ['high-model'] }
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'routing', 'hardware_model_planner', 'latest.json'),
      history_path: path.join(tmp, 'state', 'routing', 'hardware_model_planner', 'history.jsonl'),
      plan_path: path.join(tmp, 'state', 'routing', 'hardware_model_planner', 'plan.json')
    }
  });

  const env = {
    HARDWARE_MODEL_PLANNER_ROOT: tmp,
    HARDWARE_MODEL_PLANNER_POLICY_PATH: policyPath,
    HW_PLANNER_CPU_THREADS: '6',
    HW_PLANNER_RAM_GB: '8',
    HW_PLANNER_VRAM_GB: '2'
  };

  const r = run(['plan', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'plan should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.tier === 'nano', 'small hardware should classify as nano');
  assert.ok(Array.isArray(out.recommended_models) && out.recommended_models[0] === 'nano-model');

  console.log('hardware_model_planner.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`hardware_model_planner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

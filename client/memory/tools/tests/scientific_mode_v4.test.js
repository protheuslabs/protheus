#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'scientific_mode_v4.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function baseRunArgs() {
  return [
    'run',
    '--observation=Revenue dropped post pricing update',
    '--question=Why did conversion decline?',
    '--hypothesis=If price rises then conversion falls',
    '--prediction=Conversion improves when price normalizes',
    '--effect_size=0.16',
    '--p_value=0.03',
    '--sample_size=220'
  ];
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-mode-v4-'));
  const policyPath = path.join(tmp, 'config', 'scientific_mode_v4_policy.json');
  const latestPath = path.join(tmp, 'state', 'science', 'scientific_mode_v4', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'scientific_mode_v4', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scientific_mode_v4: false,
    gates: { research: true, weaver: true, redteam: true },
    strict_gate_enforcement: true,
    fallback_mode: 'legacy_research_lane',
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    SCI_MODE_V4_ROOT: tmp,
    SCI_MODE_V4_POLICY_PATH: policyPath,
    SCI_LOOP_ROOT: tmp,
    HYPOTHESIS_FORGE_ROOT: tmp,
    REASONING_MIRROR_ROOT: tmp
  };

  let out = run(baseRunArgs(), env);
  assert.strictEqual(out.status, 0, out.stderr || 'flag-off run should pass fallback path');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'payload should be ok');
  assert.strictEqual(payload.result, 'flag_disabled_fallback', 'should fallback when flag is off');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scientific_mode_v4: true,
    gates: { research: true, weaver: true, redteam: true },
    strict_gate_enforcement: true,
    fallback_mode: 'legacy_research_lane',
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  out = run(baseRunArgs(), env);
  assert.strictEqual(out.status, 0, out.stderr || 'flag-on run should execute integrated flow');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'integrated payload should be ok');
  assert.strictEqual(payload.result, 'integrated_scientific_flow_executed', 'integrated mode should execute');
  assert.ok(payload.loop && payload.forge && payload.mirror, 'integrated artifacts missing');
  assert.ok(payload.enhanced_mirror && payload.enhanced_mirror.ok === true, 'enhanced mirror artifact missing');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('scientific_mode_v4.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`scientific_mode_v4.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

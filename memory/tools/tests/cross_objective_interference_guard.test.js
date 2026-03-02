#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'cross_objective_interference_guard.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-interference-'));
  const dateStr = '2026-03-02';
  const inputDir = path.join(tmp, 'state', 'sensory', 'analysis', 'objective_interference');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'objective_interference_guard');
  const policyPath = path.join(tmp, 'config', 'cross_objective_interference_guard_policy.json');

  writeJson(path.join(inputDir, `${dateStr}.json`), {
    candidate_id: 'detector_candidate_v12',
    objectives: [
      { objective_id: 'T1_make_jay_billionaire_v1', before_metric: 0.74, after_metric: 0.75 },
      { objective_id: 'T1_generational_wealth_v1', before_metric: 0.69, after_metric: 0.62 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    default_max_negative_delta: 0.03,
    objective_interference_budget: {
      T1_make_jay_billionaire_v1: 0.02,
      T1_generational_wealth_v1: 0.03
    },
    paths: {
      input_dir: inputDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'cross_objective_interference_guard', 'run should produce interference output');
  assert.strictEqual(out.payload.promotion_blocked, true, 'regression beyond budget should block promotion');
  assert.strictEqual((out.payload.blocked_objectives || []).length, 1, 'one objective should violate interference budget');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'cross_objective_interference_guard', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('cross_objective_interference_guard.test.js: OK');
} catch (err) {
  console.error(`cross_objective_interference_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

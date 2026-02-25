#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'nursery', 'specialist_training.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeJsonl(p, rows) {
  mkDir(path.dirname(p));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(p, body + (body ? '\n' : ''), 'utf8');
}

function parsePayload(stdout) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch {}
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    payload: parsePayload(r.stdout)
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-training-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const outDir = path.join(tmp, 'state', 'nursery', 'training');
  const hardwarePlanPath = path.join(tmp, 'state', 'routing', 'hardware_plan.json');
  const date = '2026-02-25';

  writeJson(policyPath, {
    version: '1.0',
    seed_id_default: 'tinyllama_seed',
    curation: {
      min_rows: 2,
      max_rows: 50,
      include_outcomes: ['shipped', 'no_change', 'reverted']
    },
    profiles: {
      small: {
        adapter: 'lora',
        rank: 8,
        alpha: 16,
        batch_size: 4,
        epochs: 1,
        max_train_minutes: 10,
        max_ram_gb: 8,
        max_gpu_vram_gb: 0
      }
    },
    promotion_thresholds: {
      min_quality: 0.8,
      min_safety: 0.9,
      max_cost_per_1k: 0.05,
      max_latency_ms: 150
    }
  });

  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    {
      ts: `${date}T00:00:00.000Z`,
      type: 'autonomy_run',
      outcome: 'shipped',
      proposal_type: 'external_intel',
      objective_id: 'objective_a',
      strategy_rank: { components: { value_currency: 'delivery' } }
    },
    {
      ts: `${date}T01:00:00.000Z`,
      type: 'autonomy_run',
      outcome: 'no_change',
      proposal_type: 'external_intel',
      objective_id: 'objective_a',
      strategy_rank: { components: { value_currency: 'delivery' } }
    }
  ]);

  writeJson(hardwarePlanPath, {
    summary: {
      class: 'small'
    }
  });

  const evalPath = path.join(tmp, 'eval.json');
  writeJson(evalPath, {
    quality: 0.91,
    safety: 0.97,
    cost_per_1k: 0.02,
    latency_ms: 90
  });

  const env = {
    NURSERY_TRAINING_POLICY_PATH: policyPath,
    NURSERY_TRAINING_RUNS_DIR: runsDir,
    NURSERY_TRAINING_OUT_DIR: outDir,
    NURSERY_TRAINING_HARDWARE_PLAN_PATH: hardwarePlanPath
  };

  try {
    let r = run(['curate', date, '--days=1', '--write=1'], env);
    assert.strictEqual(r.status, 0, `curate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'curate should pass min rows');
    assert.ok(r.payload.dataset_path, 'curate should write dataset path');

    r = run(['plan', '--profile=small', '--seed=tinyllama_seed'], env);
    assert.strictEqual(r.status, 0, `plan should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'plan should pass');
    assert.strictEqual(r.payload.plan.adapter, 'lora', 'small profile should use lora');

    r = run(['evaluate', `--eval-file=${evalPath}`], env);
    assert.strictEqual(r.status, 0, `evaluate should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'evaluation should pass thresholds');

    r = run(['promote', '--checkpoint=ckpt_001', `--eval-file=${evalPath}`], env);
    assert.strictEqual(r.status, 0, `promote should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.promoted === true, 'promote should be true for passing eval');

    writeJson(evalPath, {
      quality: 0.6,
      safety: 0.8,
      cost_per_1k: 0.1,
      latency_ms: 300
    });
    r = run(['promote', '--checkpoint=ckpt_bad', `--eval-file=${evalPath}`], env);
    assert.notStrictEqual(r.status, 0, 'promote should fail strict defaults on bad eval');
    assert.ok(r.payload && r.payload.ok === false, 'bad evaluation should fail');

    console.log('specialist_training.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`specialist_training.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

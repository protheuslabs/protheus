#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'analysis_quality_slo_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-slo-'));
  const dateStr = '2026-03-02';
  const goldDir = path.join(tmp, 'state', 'sensory', 'analysis', 'gold_eval_blind');
  const abstainDir = path.join(tmp, 'state', 'sensory', 'analysis', 'abstain_uncertainty');
  const execDir = path.join(tmp, 'state', 'ops', 'execution_slo');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'quality_slo');
  const policyPath = path.join(tmp, 'config', 'analysis_quality_slo_contract_policy.json');

  writeJson(path.join(goldDir, `${dateStr}.json`), {
    metrics: {
      precision: 0.8,
      recall: 0.76,
      f1: 0.78,
      brier: 0.14
    }
  });
  writeJson(path.join(abstainDir, `${dateStr}.json`), {
    source_hypothesis_count: 20,
    abstain_count: 4
  });
  writeJson(path.join(execDir, 'latest.json'), {
    execution_green: true
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    slo: {
      min_precision: 0.62,
      min_recall: 0.55,
      min_f1: 0.58,
      max_brier: 0.28,
      max_abstain_rate: 0.45
    },
    paths: {
      gold_eval_dir: goldDir,
      abstain_dir: abstainDir,
      execution_slo_latest: path.join(execDir, 'latest.json'),
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'analysis_quality_slo_contract', 'run should produce SLO output');
  assert.strictEqual(out.payload.analysis_pass, true, 'analysis metrics should pass SLO');
  assert.strictEqual(out.payload.execution_green, true, 'execution should be read independently');
  assert.strictEqual(out.payload.promotion_gate_pass, true, 'promotion gate should follow analysis SLO');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'analysis_quality_slo_contract', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('analysis_quality_slo_contract.test.js: OK');
} catch (err) {
  console.error(`analysis_quality_slo_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

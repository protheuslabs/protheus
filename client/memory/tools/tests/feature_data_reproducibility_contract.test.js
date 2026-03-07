#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'feature_data_reproducibility_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-repro-'));
  const dateStr = '2026-03-02';
  const featuresDir = path.join(tmp, 'state', 'sensory', 'features');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'reproducibility');
  const policyPath = path.join(tmp, 'config', 'feature_data_reproducibility_contract_policy.json');

  writeJson(path.join(featuresDir, `${dateStr}.json`), {
    rows: [
      { id: 'x1', f_a: 0.7, f_b: 0.3 },
      { id: 'x2', f_a: -0.2, f_b: 0.1 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    decision_threshold: 0.5,
    detector_version_default: 'detector_v1',
    paths: {
      features_dir: featuresDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--detector-version=detector_v9', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'feature_data_reproducibility_contract', 'run should produce snapshot output');
  assert.ok(out.payload.snapshot_id, 'snapshot id should be generated');

  out = run(['replay', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'feature_data_reproducibility_replay', 'replay should produce replay output');
  assert.strictEqual(out.payload.replay.equivalent, true, 'replay should be equivalent');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'feature_data_reproducibility_contract', 'status should read latest output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('feature_data_reproducibility_contract.test.js: OK');
} catch (err) {
  console.error(`feature_data_reproducibility_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

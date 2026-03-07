#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'distribution_shift_decomposition_engine.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-shift-'));
  const dateStr = '2026-03-02';
  const featuresDir = path.join(tmp, 'state', 'sensory', 'features');
  const currentDir = path.join(featuresDir, 'current');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'distribution_shift');
  const policyPath = path.join(tmp, 'config', 'distribution_shift_decomposition_policy.json');

  writeJson(path.join(featuresDir, 'baseline.json'), {
    rows: [
      { source: 'reddit', topic: 'agents', style: 'discussion', population: 'builders' },
      { source: 'reddit', topic: 'agents', style: 'discussion', population: 'builders' },
      { source: 'reddit', topic: 'revenue', style: 'report', population: 'founders' }
    ]
  });

  writeJson(path.join(currentDir, `${dateStr}.json`), {
    rows: [
      { source: 'twitter', topic: 'agents', style: 'thread', population: 'general' },
      { source: 'twitter', topic: 'agents', style: 'thread', population: 'general' },
      { source: 'twitter', topic: 'agents', style: 'thread', population: 'general' }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    components: ['source', 'topic', 'style', 'population'],
    component_thresholds: {
      source: 0.2,
      topic: 0.25,
      style: 0.2,
      population: 0.2
    },
    paths: {
      baseline_path: path.join(featuresDir, 'baseline.json'),
      current_dir: currentDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'distribution_shift_decomposition_engine', 'run should produce shift output');
  assert.ok(Number(out.payload.triggered_components || 0) >= 1, 'at least one component should trigger remediation');

  const sourceRow = (out.payload.decomposition || []).find((row) => row.component === 'source');
  assert.ok(sourceRow && Number(sourceRow.shift_score || 0) > 0.2, 'source shift should exceed threshold in fixture');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'distribution_shift_decomposition_engine', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('distribution_shift_decomposition_engine.test.js: OK');
} catch (err) {
  console.error(`distribution_shift_decomposition_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

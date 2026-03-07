#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'novelty_saturation_prioritization_engine.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novelty-saturation-'));
  const dateStr = '2026-03-02';
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const noveltyDir = path.join(tmp, 'state', 'sensory', 'analysis', 'novelty_saturation');
  const policyPath = path.join(tmp, 'config', 'novelty_saturation_prioritization_policy.json');

  writeJson(path.join(noveltyDir, 'state.json'), {
    schema_id: 'novelty_saturation_state',
    version: '1.0-test',
    history: {
      agents: [6, 7, 5, 8, 6, 7],
      revenue: [2, 3, 2, 3, 2, 2]
    }
  });

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    hypotheses: [
      { id: 'a1', topic: 'agents' },
      { id: 'a2', topic: 'agents' },
      { id: 'n1', topic: 'novel_topic_alpha' },
      { id: 'n2', topic: 'novel_topic_alpha' },
      { id: 'r1', topic: 'revenue' }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    history_days: 14,
    novelty_weight: 0.7,
    saturation_weight: 0.5,
    anomaly_bonus_weight: 0.2,
    min_priority_score: -1,
    paths: {
      hypotheses_dir: hypothesesDir,
      state_path: path.join(noveltyDir, 'state.json'),
      output_dir: noveltyDir,
      latest_path: path.join(noveltyDir, 'latest.json'),
      receipts_path: path.join(noveltyDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'novelty_saturation_prioritization_engine', 'run should produce novelty output');
  assert.ok(Number(out.payload.topic_count || 0) >= 3, 'topics should be scored');

  const scores = out.payload.scores || [];
  const top = scores[0];
  assert.strictEqual(top.topic, 'novel_topic_alpha', 'novel topic should rank above saturated topic');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'novelty_saturation_prioritization_engine', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('novelty_saturation_prioritization_engine.test.js: OK');
} catch (err) {
  console.error(`novelty_saturation_prioritization_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'adversarial_hypothesis_challenger.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-challenger-'));
  const policyPath = path.join(tmp, 'config', 'adversarial_hypothesis_challenger_policy.json');
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const outputDir = path.join(tmp, 'state', 'sensory', 'analysis', 'adversarial_challenger');
  const dateStr = '2026-03-02';

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    type: 'cross_signal_hypotheses',
    date: dateStr,
    hypotheses: [
      { id: 'h_good', type: 'convergence', topic: 'revenue', confidence: 90, probability: 0.91, support_events: 12 },
      { id: 'h_weak', type: 'convergence', topic: 'automation', confidence: 88, probability: 0.82, support_events: 2 },
      { id: 'h_low', type: 'divergence', topic: 'infra', confidence: 60, probability: 0.55, support_events: 7 }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    min_priority_confidence: 78,
    min_priority_probability: 0.72,
    min_support_events: 6,
    unresolved_probability_floor: 0.78,
    paths: {
      hypotheses_dir: hypothesesDir,
      output_dir: outputDir,
      latest_path: path.join(outputDir, 'latest.json'),
      receipts_path: path.join(outputDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, `--policy=${policyPath}`, '--strict=0']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'adversarial_hypothesis_challenger', 'run should produce report');
  assert.ok(Number(out.payload.challenged_count || 0) >= 2, 'should challenge high-priority signals');
  assert.strictEqual(out.payload.promotion_blocked, true, 'weak high-priority signal should block promotion');
  assert.ok(Array.isArray(out.payload.unresolved_examples) && out.payload.unresolved_examples.length >= 1, 'should include unresolved challenger examples');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'adversarial_hypothesis_challenger', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('adversarial_hypothesis_challenger.test.js: OK');
} catch (err) {
  console.error(`adversarial_hypothesis_challenger.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

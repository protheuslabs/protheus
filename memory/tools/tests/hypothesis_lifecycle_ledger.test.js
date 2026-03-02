#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'hypothesis_lifecycle_ledger.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypothesis-lifecycle-'));
  const dateStr = '2026-03-02';
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const challengerDir = path.join(tmp, 'state', 'sensory', 'analysis', 'adversarial_challenger');
  const outcomesDir = path.join(tmp, 'state', 'sensory', 'analysis', 'hypothesis_outcomes');
  const lifecycleDir = path.join(tmp, 'state', 'sensory', 'analysis', 'hypothesis_lifecycle');
  const policyPath = path.join(tmp, 'config', 'hypothesis_lifecycle_ledger_policy.json');

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    hypotheses: [
      { id: 'h_accept', topic: 'revenue' },
      { id: 'h_test', topic: 'automation' }
    ]
  });

  writeJson(path.join(challengerDir, `${dateStr}.json`), {
    challenges: [
      {
        source_hypothesis_id: 'h_test',
        verification_outcome: 'win',
        verification_reason: 'low_support_events'
      }
    ]
  });

  writeJson(path.join(outcomesDir, `${dateStr}.json`), {
    outcomes: [
      { hypothesis_id: 'h_accept', outcome: 'accepted' }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    paths: {
      hypotheses_dir: hypothesesDir,
      challenger_dir: challengerDir,
      outcomes_dir: outcomesDir,
      state_path: path.join(lifecycleDir, 'state.json'),
      ledger_path: path.join(lifecycleDir, 'ledger.jsonl'),
      output_dir: lifecycleDir,
      latest_path: path.join(lifecycleDir, 'latest.json'),
      receipts_path: path.join(lifecycleDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'hypothesis_lifecycle_ledger', 'run should produce lifecycle output');
  assert.ok(Number(out.payload.hypothesis_count || 0) >= 2, 'hypotheses should be tracked');
  assert.ok(Number(out.payload.transitions_emitted || 0) >= 2, 'transitions should be emitted on first run');
  assert.strictEqual(Number(out.payload.status_summary.accepted || 0), 1, 'one hypothesis should be accepted');
  assert.strictEqual(Number(out.payload.status_summary.tested || 0), 1, 'one hypothesis should be tested');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'hypothesis_lifecycle_ledger', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('hypothesis_lifecycle_ledger.test.js: OK');
} catch (err) {
  console.error(`hypothesis_lifecycle_ledger.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

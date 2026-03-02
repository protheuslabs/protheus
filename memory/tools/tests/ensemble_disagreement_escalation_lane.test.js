#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'ensemble_disagreement_escalation_lane.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-disagreement-'));
  const dateStr = '2026-03-02';
  const packDir = path.join(tmp, 'state', 'sensory', 'eval', 'ensemble');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'ensemble_disagreement');
  const policyPath = path.join(tmp, 'config', 'ensemble_disagreement_escalation_policy.json');

  writeJson(path.join(packDir, `${dateStr}.json`), {
    items: [
      {
        id: 'case_escalate',
        risk_tier: 'high',
        model_scores: {
          model_a: 0.12,
          model_b: 0.82,
          model_c: 0.46
        }
      },
      {
        id: 'case_accept',
        risk_tier: 'normal',
        model_scores: {
          model_a: 0.55,
          model_b: 0.58,
          model_c: 0.52
        }
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    disagreement_threshold: 0.32,
    min_models: 3,
    high_risk_disagreement_threshold: 0.24,
    paths: {
      ensemble_pack_dir: packDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'ensemble_disagreement_escalation_lane', 'run should produce disagreement output');
  assert.strictEqual(Number(out.payload.scored_count || 0), 2, 'two cases should be scored');
  assert.strictEqual(Number(out.payload.escalated_count || 0), 1, 'one case should escalate for high divergence');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'ensemble_disagreement_escalation_lane', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ensemble_disagreement_escalation_lane.test.js: OK');
} catch (err) {
  console.error(`ensemble_disagreement_escalation_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

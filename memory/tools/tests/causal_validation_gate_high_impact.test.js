#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'causal_validation_gate_high_impact.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-validation-gate-'));
  const dateStr = '2026-03-02';
  const claimsDir = path.join(tmp, 'state', 'sensory', 'analysis', 'high_impact_claims');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'causal_validation_gate');
  const policyPath = path.join(tmp, 'config', 'causal_validation_gate_policy.json');

  writeJson(path.join(claimsDir, `${dateStr}.json`), {
    claims: [
      {
        claim_id: 'claim_ok',
        impact_score: 0.81,
        replay_evidence_confidence: 0.8,
        intervention_count: 2,
        intervention_evidence_confidence: 0.77,
        source_reliability: 0.75
      },
      {
        claim_id: 'claim_block',
        impact_score: 0.9,
        replay_evidence_confidence: 0.42,
        intervention_count: 0,
        intervention_evidence_confidence: 0.1,
        source_reliability: 0.4
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    high_impact_threshold: 0.7,
    min_causal_confidence: 0.65,
    min_intervention_count: 1,
    weights: {
      replay_evidence: 0.45,
      intervention_evidence: 0.35,
      source_reliability: 0.2
    },
    paths: {
      claims_dir: claimsDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'causal_validation_gate_high_impact', 'run should produce gate output');
  assert.strictEqual(Number(out.payload.validated_count || 0), 1, 'one claim should pass');
  assert.strictEqual(Number(out.payload.blocked_count || 0), 1, 'one claim should be blocked');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'causal_validation_gate_high_impact', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('causal_validation_gate_high_impact.test.js: OK');
} catch (err) {
  console.error(`causal_validation_gate_high_impact.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

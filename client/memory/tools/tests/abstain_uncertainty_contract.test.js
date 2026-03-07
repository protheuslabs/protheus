#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'abstain_uncertainty_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abstain-contract-'));
  const dateStr = '2026-03-02';
  const hypothesesDir = path.join(tmp, 'state', 'sensory', 'cross_signal', 'hypotheses');
  const resolutionDir = path.join(tmp, 'state', 'sensory', 'analysis', 'abstain_resolution');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'abstain_uncertainty');
  const policyPath = path.join(tmp, 'config', 'abstain_uncertainty_contract_policy.json');

  writeJson(path.join(hypothesesDir, `${dateStr}.json`), {
    hypotheses: [
      { id: 'h_low', topic: 'revenue', confidence: 61, probability: 0.52, support_events: 2 },
      { id: 'h_high', topic: 'agents', confidence: 89, probability: 0.91, support_events: 9 }
    ]
  });

  const abstainId = 'abs_' + require('crypto').createHash('sha256').update(`${dateStr}|h_low|insufficient_confidence|insufficient_probability|insufficient_support_events`).digest('hex').slice(0, 20);
  writeJson(path.join(resolutionDir, `${dateStr}.json`), {
    resolutions: [
      { abstain_id: abstainId, resolved: true, outcome: 'resolved_with_human_context', resolution_ts: `${dateStr}T18:22:00.000Z` }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    abstain_if_confidence_below: 72,
    abstain_if_probability_below: 0.67,
    abstain_if_support_events_below: 4,
    reason_codes: {
      low_confidence: 'insufficient_confidence',
      low_probability: 'insufficient_probability',
      low_support: 'insufficient_support_events'
    },
    paths: {
      hypotheses_dir: hypothesesDir,
      resolution_dir: resolutionDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'abstain_uncertainty_contract', 'run should produce contract output');
  assert.strictEqual(Number(out.payload.abstain_count || 0), 1, 'one weak hypothesis should abstain');
  assert.strictEqual(Number(out.payload.routed_count || 0), 1, 'one strong hypothesis should route normally');
  assert.ok(Array.isArray(out.payload.abstained) && out.payload.abstained[0].reason_codes.length >= 1, 'abstain output should include reason codes');
  assert.strictEqual(out.payload.abstained[0].resolved, true, 'abstain resolution should be tracked when provided');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'abstain_uncertainty_contract', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('abstain_uncertainty_contract.test.js: OK');
} catch (err) {
  console.error(`abstain_uncertainty_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

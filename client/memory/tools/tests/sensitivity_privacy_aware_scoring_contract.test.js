#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'sensitivity_privacy_aware_scoring_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scoring-'));
  const dateStr = '2026-03-02';
  const inputDir = path.join(tmp, 'state', 'sensory', 'analysis', 'scoring_input');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'privacy_scoring');
  const policyPath = path.join(tmp, 'config', 'sensitivity_privacy_scoring_policy.json');

  writeJson(path.join(inputDir, `${dateStr}.json`), {
    rows: [
      {
        signal_id: 'sig_public',
        sensitivity_class: 'general',
        base_score: 0.75,
        raw_text: 'public trend summary'
      },
      {
        signal_id: 'sig_sensitive',
        sensitivity_class: 'pii',
        base_score: 0.9,
        raw_text: 'contains personal data',
        sensitive_use_approved: false
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    sensitive_classes: ['pii', 'health', 'financial_secret'],
    restricted_multiplier: 0.4,
    mask_fields: ['raw_text', 'source_payload'],
    require_explicit_approval: true,
    paths: {
      input_dir: inputDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=0', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'sensitivity_privacy_aware_scoring_contract', 'run should produce scoring output');
  assert.strictEqual(Number(out.payload.scored_count || 0), 1, 'public signal should be scored');
  assert.strictEqual(Number(out.payload.blocked_count || 0), 1, 'unapproved sensitive signal should be blocked');
  assert.strictEqual(out.payload.blocked[0].masked_row.raw_text, '[REDACTED]', 'blocked sensitive content should be masked');

  out = run(['status', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'sensitivity_privacy_aware_scoring_contract', 'status should read output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('sensitivity_privacy_aware_scoring_contract.test.js: OK');
} catch (err) {
  console.error(`sensitivity_privacy_aware_scoring_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

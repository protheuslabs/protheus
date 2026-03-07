#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'proposal_type_outcome_calibrator.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-type-calibrator-'));
  const policyPath = path.join(tmp, 'config', 'proposal_type_outcome_calibrator_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    target_pass_rate: 0.6,
    max_offset_abs: 0.2,
    min_samples: 2,
    outputs: {
      state_path: path.join(tmp, 'state', 'state.json'),
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl')
    }
  });

  const env = {
    PROPOSAL_TYPE_CALIBRATOR_ROOT: tmp,
    PROPOSAL_TYPE_CALIBRATOR_POLICY_PATH: policyPath
  };

  const r = run(['calibrate', '--rows-json=[{"proposal_type":"external_intel","ok":true},{"proposal_type":"external_intel","ok":false},{"proposal_type":"maintenance","ok":true}]', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'calibrate should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  assert.ok(out.proposal_type_threshold_offsets && typeof out.proposal_type_threshold_offsets.external_intel === 'number', 'external_intel offset should exist');

  console.log('proposal_type_outcome_calibrator.test.js: OK');
}

try { main(); } catch (err) { console.error(`proposal_type_outcome_calibrator.test.js: FAIL: ${err.message}`); process.exit(1); }

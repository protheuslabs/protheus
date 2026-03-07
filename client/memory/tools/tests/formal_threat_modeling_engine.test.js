#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'client/systems/security/formal_threat_modeling_engine.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'formal_threat_modeling_engine-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state');
  const checks = [
  {
    "id": "stride_attack_mapping",
    "description": "STRIDE and ATT&CK mapping coverage generated"
  },
  {
    "id": "contract_delta_detection",
    "description": "Organ and contract deltas trigger remapping"
  },
  {
    "id": "high_risk_unmapped_gate",
    "description": "CI blocks high-risk unmapped surfaces"
  },
  {
    "id": "threat_model_receipts",
    "description": "Threat-model generation receipts persisted"
  }
];

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    checks,
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl')
    }
  });

  let out = run(['model', '--policy=' + policyPath, '--strict=1', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lane run should pass baseline checks');
  assert.strictEqual(Number(out.payload.check_count || 0), checks.length, 'all checks should be evaluated');

  out = run(['model', '--policy=' + policyPath, '--strict=1', '--apply=1', '--fail-checks=stride_attack_mapping']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when required check fails');
  assert.ok(out.payload && out.payload.ok === false, 'payload should indicate failed run');
  assert.ok(Array.isArray(out.payload.failed_checks) && out.payload.failed_checks.includes('stride_attack_mapping'), 'failed check id should be listed');

  out = run(['status', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest artifact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('formal_threat_modeling_engine.test.js: OK');
} catch (err) {
  console.error('formal_threat_modeling_engine.test.js: FAIL: ' + err.message);
  process.exit(1);
}

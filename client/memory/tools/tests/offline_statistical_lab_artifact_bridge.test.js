#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'sensory', 'offline_statistical_lab_artifact_bridge.js');

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

function canon(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
}

function hash(text, len = 64) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, len);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-lab-bridge-'));
  const dateStr = '2026-03-02';
  const incomingDir = path.join(tmp, 'state', 'sensory', 'offline_lab', 'artifacts');
  const outDir = path.join(tmp, 'state', 'sensory', 'analysis', 'offline_lab_bridge');
  const policyPath = path.join(tmp, 'config', 'offline_statistical_lab_artifact_bridge_policy.json');

  const payload = {
    experiment: 'calibration_diagnostics',
    brier_improvement: 0.04,
    notes: ['offline_r_run']
  };
  const payloadHash = hash(canon(payload), 64);
  const signature = hash(`lab_shared_secret_v1|${payloadHash}`, 64);

  writeJson(path.join(incomingDir, `${dateStr}.json`), {
    artifact_id: 'lab_artifact_001',
    producer: 'offline_r_lab',
    job_type: 'calibration_report',
    signing_key_id: 'lab_key_1',
    signature,
    payload
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_fields: ['artifact_id', 'producer', 'job_type', 'payload', 'signature', 'signing_key_id'],
    trusted_signing_keys: {
      lab_key_1: 'lab_shared_secret_v1'
    },
    paths: {
      incoming_dir: incomingDir,
      output_dir: outDir,
      latest_path: path.join(outDir, 'latest.json'),
      receipts_path: path.join(outDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'offline_statistical_lab_artifact_bridge', 'run should produce bridge output');
  assert.strictEqual(out.payload.ok, true, 'artifact should verify with trusted signature');
  assert.ok(out.payload.provenance && out.payload.provenance.signing_key_id === 'lab_key_1', 'provenance should be attached');

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'offline_statistical_lab_artifact_bridge', 'status should read latest output');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('offline_statistical_lab_artifact_bridge.test.js: OK');
} catch (err) {
  console.error(`offline_statistical_lab_artifact_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

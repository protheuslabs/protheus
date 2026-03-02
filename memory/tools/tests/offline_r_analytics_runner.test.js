#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'research', 'offline_r_analytics_runner.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-r-analytics-'));
  const dateStr = '2026-03-02';
  const incomingDir = path.join(tmp, 'state', 'sensory', 'offline_lab', 'artifacts');
  const bridgeOutDir = path.join(tmp, 'state', 'sensory', 'analysis', 'offline_lab_bridge');
  const bridgePolicyPath = path.join(tmp, 'config', 'offline_statistical_lab_artifact_bridge_policy.json');
  const runnerPolicyPath = path.join(tmp, 'config', 'offline_r_analytics_runner_policy.json');
  const runnerOutDir = path.join(tmp, 'state', 'research', 'offline_r_analytics_runner');

  writeJson(bridgePolicyPath, {
    version: '1.0-test',
    enabled: true,
    required_fields: ['artifact_id', 'producer', 'job_type', 'payload', 'signature', 'signing_key_id'],
    trusted_signing_keys: {
      lab_key_1: 'lab_shared_secret_v1'
    },
    paths: {
      incoming_dir: incomingDir,
      output_dir: bridgeOutDir,
      latest_path: path.join(bridgeOutDir, 'latest.json'),
      receipts_path: path.join(bridgeOutDir, 'receipts.jsonl')
    }
  });

  writeJson(runnerPolicyPath, {
    version: '1.0-test',
    enabled: true,
    producer: 'offline_r_analytics_runner',
    job_type: 'research_organ_calibration',
    engine: {
      allow_external_r: false,
      command: 'Rscript',
      script_path: path.join(ROOT, 'research', 'r', 'offline_research_analytics.R'),
      timeout_ms: 3000
    },
    fit_criteria: {
      min_sample_size: 90,
      min_brier_improvement: 0.01,
      min_causal_precision_lift: 0.001,
      max_confidence_uplift: 0.12
    },
    signing: {
      signing_key_id: 'lab_key_1',
      signing_secret: 'lab_shared_secret_v1'
    },
    bridge: {
      enabled: true,
      incoming_dir: incomingDir,
      policy_path: bridgePolicyPath,
      auto_run_bridge: true,
      require_bridge_success: true
    },
    paths: {
      output_dir: runnerOutDir,
      latest_path: path.join(runnerOutDir, 'latest.json'),
      receipts_path: path.join(runnerOutDir, 'receipts.jsonl')
    }
  });

  let out = run(['run', dateStr, '--objective=queue calibration uplift', '--strict=1', `--policy=${runnerPolicyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'offline_r_analytics_runner', 'run should produce runner payload');
  assert.strictEqual(out.payload.ok, true, 'runner should succeed');
  assert.ok(out.payload.metrics && out.payload.metrics.fit, 'runner should report fit criteria');
  assert.ok(Number(out.payload.metrics.confidence_uplift || 0) >= 0, 'runner should produce bounded uplift');
  assert.ok(out.payload.bridge && out.payload.bridge.ok === true, 'bridge execution should succeed');

  const incomingPath = path.join(incomingDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(incomingPath), 'signed bridge artifact should be written');
  assert.ok(fs.existsSync(path.join(bridgeOutDir, 'latest.json')), 'bridge latest output should exist');

  out = run(['status', `--policy=${runnerPolicyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'offline_r_analytics_runner', 'status should return latest payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('offline_r_analytics_runner.test.js: OK');
} catch (err) {
  console.error(`offline_r_analytics_runner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'meta_science_active_learning_loop.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
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

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-science-'));
  const queuePath = path.join(tmp, 'state', 'sensory', 'analysis', 'active_learning', 'queue.jsonl');
  const latestPath = path.join(tmp, 'state', 'science', 'meta_science', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'meta_science', 'history.jsonl');
  const requestsPath = path.join(tmp, 'state', 'science', 'meta_science', 'active_learning_requests.json');
  const proposalsPath = path.join(tmp, 'state', 'science', 'meta_science', 'primitive_candidates.json');
  const sciLatestPath = path.join(tmp, 'state', 'science', 'scientific_mode_v4', 'latest.json');
  const policyPath = path.join(tmp, 'config', 'meta_science_active_learning_policy.json');

  writeJsonl(queuePath, [
    { case_id: 'c1', topic: 'revenue', uncertainty_score: 0.91, impact_score: 0.86, evidence_gap: 'causal_path_missing' },
    { case_id: 'c2', topic: 'retention', uncertainty_score: 0.84, impact_score: 0.73, evidence_gap: 'contradictory_signals' },
    { case_id: 'c3', topic: 'latency', uncertainty_score: 0.42, impact_score: 0.61, evidence_gap: 'below_uncertainty_floor' }
  ]);

  writeJson(sciLatestPath, {
    loop: { brier_score: 0.41 },
    forge: { top_hypothesis: { score: 0.49 } },
    bias_risk: 0.33
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_contracts: false,
    quality_thresholds: {
      min_calibration_score: 0.65,
      max_bias_risk: 0.35,
      min_method_effectiveness: 0.55
    },
    active_learning: {
      enabled: true,
      top_k_requests: 2,
      min_uncertainty: 0.55,
      min_impact: 0.25
    },
    primitive_proposals: {
      enabled: true,
      max_candidates: 3
    },
    paths: {
      active_learning_queue_path: queuePath,
      scientific_mode_latest_path: sciLatestPath,
      latest_path: latestPath,
      history_path: historyPath,
      requests_path: requestsPath,
      proposals_path: proposalsPath
    }
  });

  let out = run(['run', '--brier=0.42', '--bias_risk=0.37', '--method_effectiveness=0.43', `--policy=${policyPath}`], {
    META_SCIENCE_ROOT: tmp,
    META_SCIENCE_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'meta_science_active_learning_loop', 'expected meta-science payload');
  assert.ok(Array.isArray(out.payload.active_learning_requests), 'active-learning requests missing');
  assert.strictEqual(out.payload.active_learning_requests.length, 2, 'top_k request selection mismatch');
  assert.ok(Array.isArray(out.payload.primitive_candidates), 'primitive candidates missing');
  assert.ok(out.payload.primitive_candidates.length >= 2, 'expected candidate proposals for weak metrics');
  assert.strictEqual(out.payload.metrics.quality_pass, false, 'quality should fail for weak metrics');

  out = run(['status', `--policy=${policyPath}`], {
    META_SCIENCE_ROOT: tmp,
    META_SCIENCE_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should succeed');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: false,
    paths: {
      active_learning_queue_path: queuePath,
      scientific_mode_latest_path: sciLatestPath,
      latest_path: latestPath,
      history_path: historyPath,
      requests_path: requestsPath,
      proposals_path: proposalsPath
    }
  });

  out = run(['run', `--policy=${policyPath}`], {
    META_SCIENCE_ROOT: tmp,
    META_SCIENCE_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.result, 'disabled_by_policy', 'disabled policy should short-circuit');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('meta_science_active_learning_loop.test.js: OK');
} catch (err) {
  console.error(`meta_science_active_learning_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

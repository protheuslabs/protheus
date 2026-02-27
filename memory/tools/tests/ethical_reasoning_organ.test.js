#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected json stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'ethical_reasoning_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ethical-reasoning-'));

  const policyPath = path.join(tmp, 'config', 'ethical_reasoning_policy.json');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'ethical_reasoning');
  const weaverPath = path.join(tmp, 'state', 'autonomy', 'weaver', 'latest.json');
  const mirrorPath = path.join(tmp, 'state', 'autonomy', 'mirror_organ', 'latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    thresholds: {
      monoculture_warn_share: 0.6,
      high_impact_share: 0.7,
      maturity_min_for_prior_updates: 0.4,
      mirror_pressure_warn: 0.5
    },
    value_priors: {
      adaptive_value: 0.2,
      user_value: 0.2,
      quality: 0.2,
      learning: 0.2,
      delivery: 0.2
    },
    max_prior_delta_per_run: 0.05,
    integration: {
      weaver_latest_path: weaverPath,
      mirror_latest_path: mirrorPath
    }
  });
  writeJson(weaverPath, {
    run_id: 'weaver_demo',
    objective_id: 'heroic_growth',
    value_context: {
      allocations: [
        { metric_id: 'revenue', value_currency: 'revenue', share: 0.81, raw_score: 0.9 },
        { metric_id: 'learning', value_currency: 'learning', share: 0.11, raw_score: 0.5 },
        { metric_id: 'quality', value_currency: 'quality', share: 0.08, raw_score: 0.45 }
      ]
    }
  });
  writeJson(mirrorPath, {
    pressure_score: 0.77,
    reasons: ['drift_pressure_high']
  });

  const env = {
    ...process.env,
    ETHICAL_REASONING_POLICY_PATH: policyPath,
    ETHICAL_REASONING_STATE_DIR: stateDir
  };

  const runProc = runNode(scriptPath, ['run', '--objective-id=heroic_growth', '--maturity-score=0.9'], env, repoRoot);
  assert.strictEqual(runProc.status, 0, runProc.stderr || runProc.stdout);
  const runOut = parseJson(runProc, 'run');
  assert.strictEqual(runOut.ok, true);
  assert.ok(Array.isArray(runOut.reason_codes) && runOut.reason_codes.includes('ethical_monoculture_warning'));
  assert.ok(Array.isArray(runOut.reason_codes) && runOut.reason_codes.includes('ethical_mirror_pressure_warning'));
  assert.ok(Array.isArray(runOut.tradeoff_receipts) && runOut.tradeoff_receipts.length >= 1);
  assert.strictEqual(runOut.summary.priors_updated, true);

  const statusProc = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const statusOut = parseJson(statusProc, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.priors && typeof statusOut.priors === 'object');
  assert.ok(fs.existsSync(path.join(stateDir, 'tradeoff_receipts.jsonl')), 'tradeoff receipts should be persisted');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ethical_reasoning_organ.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`ethical_reasoning_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

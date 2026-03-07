#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'enhanced_reasoning_mirror.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-mirror-'));
  const policyPath = path.join(tmp, 'config', 'enhanced_reasoning_mirror_policy.json');
  const schedulerPolicyPath = path.join(tmp, 'config', 'experiment_scheduler_policy.json');
  const latestPath = path.join(tmp, 'state', 'science', 'enhanced_reasoning_mirror', 'latest.json');
  const uiPath = path.join(tmp, 'state', 'science', 'enhanced_reasoning_mirror', 'ui_contract.json');
  const historyPath = path.join(tmp, 'state', 'science', 'enhanced_reasoning_mirror', 'history.jsonl');
  const routeHypothesisPath = path.join(tmp, 'state', 'science', 'enhanced_reasoning_mirror', 'route_hypothesis.json');
  const routeHistoryPath = path.join(tmp, 'state', 'science', 'enhanced_reasoning_mirror', 'routed_history.jsonl');
  const forgePath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'latest.json');
  const loopPath = path.join(tmp, 'state', 'science', 'loop', 'latest.json');
  const consentMapPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'consent_map.json');
  const schedulerLatestPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'latest.json');
  const schedulerHistoryPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'history.jsonl');
  const schedulerQueuePath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'queue.jsonl');
  const schedulerNoOpPath = path.join(tmp, 'state', 'science', 'experiment_scheduler', 'noop_state.json');

  writeJson(forgePath, {
    top_hypothesis: {
      id: 'h_rev_2',
      text: 'If checkout friction drops, conversion improves',
      score: 0.78,
      rank_receipt_id: 'hyp_rank_enh_1'
    }
  });
  writeJson(loopPath, {
    receipt_id: 'sci_loop_enh_1',
    steps: [
      { id: 'experiment', output: { experiment_defined: true } },
      { id: 'analyze', output: { effect_size: 0.21, p_value: 0.02, sample_size: 340 } },
      { id: 'conclude', output: { evidence_strength: 'strong' } },
      { id: 'iterate', output: { next_experiment: 'segment_new_vs_returning' } }
    ]
  });
  writeJson(consentMapPath, {
    h_rev_2: {
      id: 'consent_h_rev_2',
      approved: true,
      expires_at: '2030-01-01T00:00:00.000Z'
    }
  });

  writeJson(schedulerPolicyPath, {
    version: '1.0-test',
    enabled: true,
    no_op_default: false,
    max_risk: 0.7,
    consent_timeout_minutes: 120,
    schedule_interval_minutes: 30,
    default_deny_without_consent: true,
    sandbox_required: true,
    paths: {
      hypotheses_path: path.join(tmp, 'state', 'science', 'hypothesis_forge', 'ranked.json'),
      queue_path: schedulerQueuePath,
      latest_path: schedulerLatestPath,
      history_path: schedulerHistoryPath,
      no_op_state_path: schedulerNoOpPath
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scientific_flag_required: true,
    min_calibration_samples: 50,
    calibration_targets: {
      brier_excellent: 0.18,
      brier_good: 0.28,
      max_confidence_gap: 0.12
    },
    uncertainty_levels: [0.8, 0.9, 0.95],
    consent_map_path: consentMapPath,
    scheduler_policy_path: schedulerPolicyPath,
    paths: {
      hypothesis_latest_path: forgePath,
      loop_latest_path: loopPath,
      latest_path: latestPath,
      ui_contract_path: uiPath,
      history_path: historyPath,
      route_hypothesis_path: routeHypothesisPath,
      routed_history_path: routeHistoryPath
    }
  });

  const env = {
    OPENCLAW_WORKSPACE: tmp,
    ENHANCED_REASONING_MIRROR_POLICY_PATH: policyPath,
    EXPERIMENT_SCHEDULER_POLICY_PATH: schedulerPolicyPath
  };

  let out = run([
    'render',
    '--scientific-mode=1',
    '--brier-score=0.16',
    '--empirical-accuracy=0.84',
    '--sample-size=340',
    '--strict=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'render should pass');
  assert.ok(out.payload.calibration_metrics, 'calibration metrics missing');
  assert.ok(out.payload.uncertainty_chart && Array.isArray(out.payload.uncertainty_chart.points), 'uncertainty chart missing');
  assert.ok(Array.isArray(out.payload.disconfirming_evidence_targets) && out.payload.disconfirming_evidence_targets.length >= 2, 'disconfirming targets missing');
  assert.ok(out.payload.suggested_experiment && out.payload.suggested_experiment.route_command, 'route command missing');
  assert.ok(out.payload.receipt_linkage && out.payload.receipt_linkage.enhanced_receipt_id, 'receipt linkage missing');

  out = run([
    'route-suggested',
    '--apply=1',
    '--strict=1',
    `--consent-map-file=${consentMapPath}`,
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'route-suggested should pass');
  assert.ok(out.payload.scheduler_result && out.payload.scheduler_result.scheduled_count >= 1, 'scheduler should schedule suggested experiment');
  assert.ok(out.payload.route_receipt_id, 'route receipt missing');

  out = run(['status', `--policy=${policyPath}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('enhanced_reasoning_mirror.test.js: OK');
} catch (err) {
  console.error(`enhanced_reasoning_mirror.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

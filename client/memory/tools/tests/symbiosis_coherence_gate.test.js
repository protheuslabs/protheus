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

function run(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'symbiosis', 'symbiosis_coherence_gate.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiosis-coherence-'));

  const policyPath = path.join(tmp, 'config', 'symbiosis_coherence_policy.json');
  const statePath = path.join(tmp, 'state', 'symbiosis', 'coherence', 'state.json');
  const latestPath = path.join(tmp, 'state', 'symbiosis', 'coherence', 'latest.json');
  const receiptsPath = path.join(tmp, 'state', 'symbiosis', 'coherence', 'receipts.jsonl');

  const identityLatestPath = path.join(tmp, 'state', 'autonomy', 'identity_anchor', 'latest.json');
  const preNeuralStatePath = path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'state.json');
  const deepSymStatePath = path.join(tmp, 'state', 'symbiosis', 'deep_understanding', 'state.json');
  const observerLatestPath = path.join(tmp, 'state', 'autonomy', 'observer_mirror', 'latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    stale_after_minutes: 120,
    thresholds: {
      low_max: 0.45,
      medium_max: 0.75,
      high_min: 0.75,
      unbounded_min: 0.8,
      sustained_high_samples: 2
    },
    recursion: {
      low_depth: 1,
      medium_depth: 2,
      high_base_depth: 4,
      high_streak_gain_interval: 1,
      require_granted_consent_for_unbounded: true,
      require_identity_clear_for_unbounded: true
    },
    paths: {
      state_path: statePath,
      latest_path: latestPath,
      receipts_path: receiptsPath,
      identity_latest_path: identityLatestPath,
      pre_neuralink_state_path: preNeuralStatePath,
      deep_symbiosis_state_path: deepSymStatePath,
      observer_mirror_latest_path: observerLatestPath
    }
  });

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 0,
    identity_drift_score: 0.04,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'granted',
    signals_total: 10,
    routed_total: 9,
    blocked_total: 1
  });
  writeJson(deepSymStatePath, {
    samples: 80,
    style: {
      directness: 0.95,
      brevity: 0.9,
      proactive_delta: 0.9
    }
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'stable' },
    summary: {
      rates: {
        ship_rate: 0.9,
        hold_rate: 0.05
      }
    }
  });

  const env = {
    ...process.env,
    SYMBIOSIS_COHERENCE_POLICY_PATH: policyPath
  };

  let out = run(scriptPath, ['evaluate', `--policy=${policyPath}`], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'first evaluate should pass');
  assert.ok(out.payload && out.payload.available === true, 'signal should be available');
  assert.strictEqual(out.payload.recursion_gate.unbounded_allowed, false, 'first pass should not unlock unbounded yet');

  out = run(scriptPath, ['evaluate', `--policy=${policyPath}`], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'second evaluate should pass');
  assert.ok(Number(out.payload.coherence_score || 0) >= 0.8, 'coherence score should be high');
  assert.strictEqual(out.payload.recursion_gate.unbounded_allowed, true, 'second pass should unlock unbounded via sustained-high samples');

  writeJson(identityLatestPath, {
    checked: 12,
    blocked: 9,
    identity_drift_score: 0.58,
    max_identity_drift_score: 0.58
  });
  writeJson(preNeuralStatePath, {
    consent_state: 'paused',
    signals_total: 10,
    routed_total: 1,
    blocked_total: 8
  });
  writeJson(observerLatestPath, {
    observer: { mood: 'strained' },
    summary: {
      rates: {
        ship_rate: 0.2,
        hold_rate: 0.7
      }
    }
  });

  out = run(scriptPath, ['evaluate', `--policy=${policyPath}`], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'low-quality evaluate should still pass');
  assert.ok(Number(out.payload.coherence_score || 1) < 0.75, 'coherence score should drop');
  assert.strictEqual(out.payload.recursion_gate.unbounded_allowed, false, 'unbounded should be disabled on low coherence');
  assert.ok(Number(out.payload.recursion_gate.allowed_depth || 0) <= 2, 'allowed depth should contract under low coherence');

  console.log('symbiosis_coherence_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`symbiosis_coherence_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

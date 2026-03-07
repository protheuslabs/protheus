#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'dream_warden_guard.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-warden-'));
  const policyPath = path.join(tmp, 'dream_warden_policy.json');
  const collectiveShadowPath = path.join(tmp, 'state', 'autonomy', 'collective_shadow', 'latest.json');
  const observerMirrorPath = path.join(tmp, 'state', 'autonomy', 'observer_mirror', 'latest.json');
  const redTeamPath = path.join(tmp, 'state', 'security', 'red_team', 'latest.json');
  const symbiosisPath = path.join(tmp, 'state', 'symbiosis', 'coherence', 'latest.json');
  const gsiStatePath = path.join(tmp, 'state', 'autonomy', 'gated_self_improvement', 'state.json');
  const outputsRoot = path.join(tmp, 'state', 'security', 'dream_warden');

  writeJson(collectiveShadowPath, {
    red_team: {
      runs: 30,
      fail_cases: 10,
      critical_fail_cases: 3,
      fail_rate: 0.3333
    },
    summary: {
      avoid: 4,
      reinforce: 0
    }
  });
  writeJson(observerMirrorPath, {
    summary: {
      rates: {
        hold_rate: 0.5
      }
    },
    observer: {
      mood: 'strained'
    }
  });
  writeJson(redTeamPath, {
    ok: true,
    summary: {
      fail_rate: 0.3333
    }
  });
  writeJson(symbiosisPath, {
    ok: true,
    coherence_score: 0.86,
    coherence_tier: 'high'
  });
  writeJson(gsiStatePath, {
    proposals: {
      a: { status: 'gated_pass' },
      b: { status: 'live_ready' },
      c: { status: 'live_merged' },
      d: { status: 'proposed' },
      e: { status: 'gated_pass' },
      f: { status: 'gated_pass' }
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    passive_only: true,
    activation: {
      min_successful_self_improvement_cycles: 5,
      min_symbiosis_score: 0.82,
      min_hours_between_runs: 0
    },
    thresholds: {
      critical_fail_cases_trigger: 1,
      red_team_fail_rate_trigger: 0.15,
      mirror_hold_rate_trigger: 0.4,
      low_symbiosis_score_trigger: 0.75,
      max_patch_candidates: 6
    },
    signals: {
      collective_shadow_latest_path: collectiveShadowPath,
      observer_mirror_latest_path: observerMirrorPath,
      red_team_latest_path: redTeamPath,
      symbiosis_latest_path: symbiosisPath,
      gated_self_improvement_state_path: gsiStatePath
    },
    outputs: {
      latest_path: path.join(outputsRoot, 'latest.json'),
      history_path: path.join(outputsRoot, 'history.jsonl'),
      receipts_path: path.join(outputsRoot, 'receipts.jsonl'),
      patch_proposals_path: path.join(outputsRoot, 'patch_proposals.jsonl'),
      ide_events_path: path.join(outputsRoot, 'ide_events.jsonl')
    }
  });

  const env = {
    DREAM_WARDEN_POLICY_PATH: policyPath
  };

  const runOut = run(['run', '2026-02-28', '--apply=0'], env);
  assert.strictEqual(runOut.status, 0, runOut.stderr || runOut.stdout);
  const payload = parseJson(runOut.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.strictEqual(payload.mode, 'active_shadow_observer');
  assert.strictEqual(payload.activation_ready, true);
  assert.ok(Number(payload.patch_proposals_count || 0) >= 2, 'should emit multiple patch proposals');
  assert.strictEqual(payload.shadow_only, true);
  assert.strictEqual(payload.passive_only, true);
  assert.strictEqual(payload.apply_executed, false);

  const statusOut = run(['status'], env);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const statusPayload = parseJson(statusOut.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.strictEqual(statusPayload.activation_ready, true);

  const illegalApply = run(['run', '2026-02-28', '--apply=1'], env);
  assert.notStrictEqual(illegalApply.status, 0, 'apply request must fail in passive mode');
  const illegalPayload = parseJson(illegalApply.stdout);
  assert.strictEqual(illegalPayload.ok, false);
  assert.strictEqual(illegalPayload.error, 'passive_mode_violation_apply_requested');
  assert.strictEqual(illegalPayload.stasis_recommendation, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dream_warden_guard.test.js: OK');
} catch (err) {
  console.error(`dream_warden_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


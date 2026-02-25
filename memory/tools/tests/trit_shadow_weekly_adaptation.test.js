#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'trit_shadow_weekly_adaptation.js');

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(fp, rows) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(fp, body ? `${body}\n` : '', 'utf8');
}

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: r.status == null ? 1 : r.status, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-adapt-'));
  const policyPath = path.join(tmp, 'config', 'trit_shadow_policy.json');
  const trustStatePath = path.join(tmp, 'state', 'trit_shadow_trust_state.json');
  const calibrationHistoryPath = path.join(tmp, 'state', 'trit_shadow_calibration', 'history.jsonl');
  const adaptationDir = path.join(tmp, 'state', 'trit_shadow_adaptation');
  const proposalsDir = path.join(tmp, 'state', 'sensory', 'proposals');

  writeJson(policyPath, {
    version: '1.0',
    trust: {
      enabled: true,
      default_source_trust: 1,
      source_trust_floor: 0.6,
      source_trust_ceiling: 1.5,
      freshness_half_life_hours: 72
    },
    influence: {
      stage: 0,
      min_confidence_stage2: 0.78,
      min_confidence_stage3: 0.85,
      max_overrides_per_day: 3,
      auto_disable_hours_on_regression: 24
    },
    semantics: {
      locked: true,
      neutral_on_missing: true,
      min_non_neutral_signals: 1,
      min_non_neutral_weight: 0.9,
      min_confidence_for_non_neutral: 0.3
    },
    adaptation: {
      enabled: true,
      cadence_days: 7,
      min_samples_per_source: 6,
      reward_step: 0.04,
      penalty_step: 0.06,
      max_delta_per_cycle: 0.08
    }
  });
  writeJson(trustStatePath, {
    schema_id: 'trit_shadow_trust_state',
    default_source_trust: 1,
    by_source: {
      spc_gate: { trust: 1, samples: 20, hit_rate: 0.6 },
      quality_lock: { trust: 1, samples: 20, hit_rate: 0.6 }
    }
  });
  writeJsonl(calibrationHistoryPath, [
    {
      ts: '2026-02-22T01:00:00.000Z',
      date: '2026-02-22',
      type: 'trit_shadow_replay_calibration',
      summary: { total_events: 30, accuracy: 0.7 },
      source_reliability: [
        { source: 'spc_gate', samples: 12, reliability: 0.8, avg_confidence: 0.7 },
        { source: 'quality_lock', samples: 12, reliability: 0.3, avg_confidence: 0.65 }
      ]
    }
  ]);

  const env = {
    AUTONOMY_TRIT_SHADOW_POLICY_PATH: policyPath,
    AUTONOMY_TRIT_SHADOW_TRUST_STATE_PATH: trustStatePath,
    AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH: calibrationHistoryPath,
    AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR: adaptationDir,
    AUTONOMY_TRIT_SHADOW_PROPOSALS_DIR: proposalsDir
  };

  const res = run(['run', '2026-02-22'], env);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'payload should be ok');
  assert.ok(Array.isArray(res.payload.suggestions), 'suggestions should be returned');
  assert.ok(Number(res.payload.suggestions.length || 0) >= 1, 'should generate at least one suggestion');
  assert.ok(res.payload.review && res.payload.review.proposal_id, 'review proposal should be generated');
  assert.ok(fs.existsSync(path.join(adaptationDir, '2026-02-22.json')), 'adaptation report should be written');
  assert.ok(fs.existsSync(path.join(adaptationDir, 'history.jsonl')), 'adaptation history should be written');

  const proposalsFile = path.join(proposalsDir, '2026-02-22.json');
  assert.ok(fs.existsSync(proposalsFile), 'proposal file should be created');
  const proposals = JSON.parse(fs.readFileSync(proposalsFile, 'utf8'));
  assert.ok(
    Array.isArray(proposals) && proposals.some((row) => row && row.type === 'trit_shadow_trust_adjustment_review'),
    'review proposal type should be present'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_weekly_adaptation.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_weekly_adaptation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

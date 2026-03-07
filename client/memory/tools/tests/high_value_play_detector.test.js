#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const mod = require(path.join(root, 'systems', 'workflow', 'high_value_play_detector.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'high-value-play-'));
  const policyPath = path.join(tmp, 'config', 'high_value_play_policy.json');
  const stateDir = path.join(tmp, 'state', 'high_value_play');
  const historyPath = path.join(stateDir, 'history.jsonl');
  const latestPath = path.join(stateDir, 'latest.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    apply_annotations: true,
    thresholds: {
      min_reward_potential: 0.6,
      max_drift_risk: 0.4,
      min_reversibility: 0.45,
      min_confidence: 0.55
    },
    false_positive: {
      enabled: true,
      lookback_days: 45,
      max_rate: 0,
      min_outcomes_for_enforcement: 1,
      confidence_penalty: 0.12,
      reward_penalty: 0.12
    }
  });

  const drafts = [
    {
      id: 'wf_high_value',
      objective_id: 'obj_high',
      objective_primary: 'Capture high-revenue opportunity with safe rollback path',
      steps: [
        { id: 'execute', type: 'command', command: 'echo run' },
        { id: 'gate', type: 'gate', command: 'echo gate' },
        { id: 'rollback_path', type: 'command', command: 'echo rollback' },
        { id: 'receipt', type: 'receipt', command: 'state/receipts/high.jsonl' }
      ],
      metrics: {
        score: 0.92,
        value_priority_score: 0.9,
        predicted_yield_delta: 0.04,
        predicted_drift_delta: 0.003,
        regression_risk: 0.12,
        safety_score: 0.94,
        trit_alignment: 0.82
      }
    },
    {
      id: 'wf_low_value',
      objective_id: 'obj_low',
      objective_primary: 'Routine low-impact task',
      steps: [{ id: 'execute', type: 'command', command: 'echo noop' }],
      metrics: {
        score: 0.32,
        value_priority_score: 0.35,
        predicted_yield_delta: 0,
        predicted_drift_delta: 0.03,
        regression_risk: 0.62,
        safety_score: 0.48,
        trit_alignment: -0.2
      }
    }
  ];

  const first = mod.detectHighValuePlays({
    date: '2026-02-26',
    run_id: 'hvp_run_1',
    drafts,
    promotable_drafts: [drafts[0]],
    dry_run: false
  }, { policyPath, stateDir, historyPath, latestPath, apply: true });

  assert.strictEqual(first.ok, true, 'first detection should pass');
  assert.ok(Array.isArray(first.drafts) && first.drafts.length === 2, 'drafts should be returned');
  const high = first.drafts.find((row) => row.id === 'wf_high_value');
  assert.ok(high && high.high_value_play, 'high value draft should be annotated');
  assert.strictEqual(high.high_value_play.flagged, true, 'high value draft should be flagged');
  assert.ok(first.summary.safe_promotable_count >= 1, 'at least one promotable draft should be safe');

  const outcomes = mod.recordExecutionOutcomes({
    date: '2026-02-26',
    run_id: 'exec_run_1',
    workflows: first.drafts,
    results: [
      {
        workflow_id: 'wf_high_value',
        ok: false,
        blocked_by_gate: false,
        high_value_play: high.high_value_play
      }
    ],
    dry_run: false
  }, { policyPath, stateDir, historyPath, latestPath });

  assert.strictEqual(outcomes.ok, true, 'outcomes recording should pass');
  assert.strictEqual(outcomes.outcomes_recorded, 1, 'one flagged outcome should be recorded');

  const second = mod.detectHighValuePlays({
    date: '2026-02-26',
    run_id: 'hvp_run_2',
    drafts,
    promotable_drafts: [drafts[0]],
    dry_run: false
  }, { policyPath, stateDir, historyPath, latestPath, apply: true });

  assert.strictEqual(second.ok, true, 'second detection should pass');
  assert.strictEqual(
    second.summary.false_positive_penalty_active,
    true,
    'false-positive penalty should activate after failed flagged outcome'
  );

  assert.ok(fs.existsSync(latestPath), 'latest snapshot should exist');
  assert.ok(fs.existsSync(historyPath), 'history should exist');
}

run();

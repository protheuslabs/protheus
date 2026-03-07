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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'autonomy', 'suggestion_lane.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestion-lane-'));
  const budgetDir = path.join(tmpRoot, 'state', 'autonomy', 'budget_guard_suggestions');
  const adaptiveDir = path.join(tmpRoot, 'state', 'adaptive', 'suggestions');
  const tritDir = path.join(tmpRoot, 'state', 'autonomy', 'trit_shadow_adaptation');
  const mirrorDir = path.join(tmpRoot, 'state', 'autonomy', 'mirror_organ', 'suggestions');
  const laneDir = path.join(tmpRoot, 'state', 'autonomy', 'suggestion_lane');
  const dateStr = '2026-02-25';

  writeJson(path.join(budgetDir, `${dateStr}.json`), [
    {
      id: 'BGS-1',
      type: 'strategy_budget_adjustment_suggestion',
      pressure: 'hard',
      action: 'pause',
      reason: 'repeated_hard_pressure',
      token_cap: 5000,
      used_est: 4900
    }
  ]);
  writeJson(path.join(adaptiveDir, `${dateStr}.json`), [
    {
      id: 'ADP-1',
      type: 'adaptive_memory_candidate',
      title: 'Theme candidate: logistics',
      theme_tag: 'logistics',
      relation_count: 6,
      suggested_action: 'Promote recurring logistics patterns into adaptive memory.'
    },
    {
      id: 'ADP-2',
      type: 'adaptive_memory_candidate',
      title: 'Theme candidate: shell',
      theme_tag: 'shell',
      relation_count: 2,
      suggested_action: 'Review shell usage pattern and add focused helper.'
    }
  ]);
  writeJson(path.join(tritDir, `${dateStr}.json`), {
    ok: true,
    suggestions: [
      {
        source: 'source_eye:test',
        delta: -0.08,
        reliability: 0.41,
        samples: 14,
        current_trust: 0.92,
        suggested_trust: 0.84
      }
    ]
  });
  writeJson(path.join(mirrorDir, `${dateStr}.json`), [
    {
      id: 'MIR-1',
      type: 'mirror_self_critique_suggestion',
      kind: 'rewire',
      title: 'Mirror queue dispatch rewire',
      summary: 'Queue pressure indicates confidence-first dispatch should be tested in proposal-only mode.',
      confidence: 0.92,
      pressure_score: 0.88,
      priority: 0.91
    }
  ]);

  const env = {
    ...process.env,
    AUTONOMY_BUDGET_GUARD_SUGGESTIONS_DIR: budgetDir,
    AUTONOMY_ADAPTIVE_SUGGESTIONS_DIR: adaptiveDir,
    AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR: tritDir,
    AUTONOMY_MIRROR_ORGAN_SUGGESTIONS_DIR: mirrorDir,
    AUTONOMY_SUGGESTION_LANE_DIR: laneDir
  };

  const runCmd = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--cap=3'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runCmd.status, 0, runCmd.stderr || 'run should succeed');
  const runOut = JSON.parse(String(runCmd.stdout || '{}').trim());
  assert.strictEqual(runOut.ok, true);
  assert.strictEqual(Number(runOut.cap || 0), 3);
  assert.strictEqual(Number(runOut.merged_count || 0), 3, 'lane should be capped to 3');
  assert.strictEqual(runOut.capped, true, 'capped should be true when candidates exceed cap');
  assert.ok(runOut.sources && Number(runOut.sources.budget_guard || 0) >= 1, 'budget source count should be present');
  assert.ok(runOut.sources && Number(runOut.sources.mirror_organ || 0) >= 1, 'mirror source count should be present');

  const lanePath = path.join(laneDir, `${dateStr}.json`);
  const lanePayload = JSON.parse(fs.readFileSync(lanePath, 'utf8'));
  assert.ok(Array.isArray(lanePayload.lane), 'lane entries should exist');
  assert.strictEqual(lanePayload.lane.length, 3);
  assert.strictEqual(lanePayload.lane[0].source, 'budget_guard', 'hard budget suggestion should rank first');
  assert.ok(lanePayload.lane.some((row) => row && row.source === 'mirror_organ'), 'mirror suggestion should make the lane');

  const statusCmd = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusCmd.status, 0, statusCmd.stderr || 'status should succeed');
  const statusOut = JSON.parse(String(statusCmd.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(Number(statusOut.merged_count || 0), 3);

  console.log('suggestion_lane.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`suggestion_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

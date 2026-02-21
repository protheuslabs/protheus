#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'strategy', 'strategy_controller.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_controller');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const runsDir = path.join(tmpRoot, 'runs');
  const trendsDir = path.join(tmpRoot, 'trends');
  const hypothesesDir = path.join(tmpRoot, 'hypotheses');
  const scorecardPath = path.join(tmpRoot, 'scorecards', 'latest.json');
  const fitnessPath = path.join(tmpRoot, 'outcome_fitness.json');
  const storePath = path.join(repoRoot, 'adaptive', 'strategy', '__strategy_controller_test_registry.json');
  const gcArchivePath = path.join(tmpRoot, 'gc_archive.jsonl');
  mkDir(runsDir);
  mkDir(trendsDir);
  mkDir(hypothesesDir);
  mkDir(path.dirname(scorecardPath));
  if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });

  writeJson(scorecardPath, {
    version: 1,
    top_strategies: [
      { strategy_id: 'default_general', stage: 'scaled', score: 44.2 }
    ]
  });
  writeJson(fitnessPath, {
    version: '1.0',
    realized_outcome_score: 0.42,
    proposal_blocks: { blocked_by_reason: { actionability_low: 3 } },
    strategy_policy: {}
  });
  writeJson(path.join(trendsDir, '2026-02-21.json'), {
    topics: [{ topic: 'model_routing' }, { topic: 'collector_reliability' }]
  });
  writeJson(path.join(hypothesesDir, '2026-02-21.json'), {
    hypotheses: [{ title: 'Lower stop_ratio with stronger success criteria' }]
  });

  const env = {
    ...process.env,
    STRATEGY_STORE_PATH: storePath,
    STRATEGY_CONTROLLER_RUNS_DIR: runsDir,
    STRATEGY_CONTROLLER_TRENDS_DIR: trendsDir,
    STRATEGY_CONTROLLER_HYPOTHESES_DIR: hypothesesDir,
    STRATEGY_CONTROLLER_SCORECARD_PATH: scorecardPath,
    STRATEGY_CONTROLLER_OUTCOME_FITNESS_PATH: fitnessPath,
    STRATEGY_CONTROLLER_GC_ARCHIVE_PATH: gcArchivePath,
    STRATEGY_CONTROLLER_REQUIRE_POLICY_ROOT: '0'
  };

  let r = runScript(repoRoot, ['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.counts.profiles_total, 0);

  r = runScript(repoRoot, [
    'intake',
    '--summary=Need a strategy around reliability and ROI pressure',
    '--text=Collector failures and stop ratio suggest we need a refined execution policy.',
    '--source=manual',
    '--kind=manual_signal',
    '--evidence=state/sensory/trends/2026-02-21.json'
  ], env);
  assert.strictEqual(r.status, 0, `intake should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out.queue_item && out.queue_item.uid, 'intake should return queue item uid');
  const queueUid = String(out.queue_item.uid);

  r = runScript(repoRoot, ['queue', '--status=queued', '--limit=10'], env);
  assert.strictEqual(r.status, 0, `queue should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(Array.isArray(out.queue));
  assert.ok(out.queue.some((q) => String(q.uid) === queueUid), 'queued item should be visible');

  const draftPath = path.join(tmpRoot, 'draft_strategy.json');
  writeJson(draftPath, {
    id: 'adaptive_reliability',
    name: 'Adaptive Reliability Strategy',
    objective: {
      primary: 'Reduce stop ratio while keeping shipped outcomes stable'
    },
    generation_mode: 'deep-thinker',
    risk_policy: {
      allowed_risks: ['low']
    },
    execution_policy: {
      mode: 'score_only'
    }
  });
  r = runScript(repoRoot, [
    'materialize',
    `--queue-id=${queueUid}`,
    `--draft-file=${draftPath}`,
    '--approval-note=materialize strategy profile for test validation'
  ], env);
  assert.strictEqual(r.status, 0, `materialize should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(String(out.profile.id), 'adaptive_reliability');

  r = runScript(repoRoot, ['touch-use', '--id=adaptive_reliability'], env);
  assert.strictEqual(r.status, 0, `touch-use should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out.profile && out.profile.usage && Number(out.profile.usage.uses_total) >= 1);

  writeJsonl(path.join(runsDir, '2026-02-21.jsonl'), [
    {
      ts: '2026-02-21T01:00:00.000Z',
      type: 'autonomy_run',
      strategy_id: 'adaptive_reliability',
      result: 'executed',
      outcome: 'shipped'
    }
  ]);
  r = runScript(repoRoot, ['sync-usage', '2026-02-21', '--days=7'], env);
  assert.strictEqual(r.status, 0, `sync-usage should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(Number(out.touched) >= 1);

  const staleProfilePath = path.join(tmpRoot, 'stale_profile.json');
  writeJson(staleProfilePath, {
    id: 'stale_strategy_candidate',
    name: 'Stale Strategy Candidate',
    status: 'disabled',
    stage: 'theory',
    created_ts: '2025-12-01T00:00:00.000Z',
    usage: {
      uses_total: 0,
      uses_30d: 0,
      use_events: [],
      last_used_ts: '2025-12-20T00:00:00.000Z'
    }
  });
  r = runScript(repoRoot, ['set-profile', `--profile-file=${staleProfilePath}`], env);
  assert.strictEqual(r.status, 1, 'set-profile without approval note should fail');
  out = parseJson(r.stdout);
  assert.strictEqual(String(out.error || ''), 'approval_note_too_short');

  r = runScript(repoRoot, [
    'set-profile',
    `--profile-file=${staleProfilePath}`,
    '--approval-note=seed stale profile for gc behavior test'
  ], env);
  assert.strictEqual(r.status, 0, `set-profile should pass: ${r.stderr}`);

  r = runScript(repoRoot, [
    'gc',
    '--inactive-days=7',
    '--min-uses-30d=1',
    '--protect-new-days=0',
    '--apply=1',
    '--approval-note=apply gc deletion for stale strategy coverage'
  ], env);
  assert.strictEqual(r.status, 0, `gc apply should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(out.snapshot && out.snapshot.id, 'gc apply should return rollback snapshot');
  const gcSnapshotId = String(out.snapshot.id);
  const removedIds = Array.isArray(out.removed) ? out.removed.map((x) => String(x.id || '')) : [];
  assert.ok(removedIds.includes('stale_strategy_candidate'), 'stale profile should be deleted by gc');
  r = runScript(repoRoot, ['get', '--id=stale_strategy_candidate'], env);
  assert.strictEqual(r.status, 1, 'stale profile should be absent after gc');

  r = runScript(repoRoot, [
    'restore',
    `--snapshot=${gcSnapshotId}`,
    '--approval-note=restore snapshot after gc for rollback validation'
  ], env);
  assert.strictEqual(r.status, 0, `restore should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(String(out.action || ''), 'restored');

  r = runScript(repoRoot, ['get', '--id=stale_strategy_candidate'], env);
  assert.strictEqual(r.status, 0, 'stale profile should be present after restore');
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);

  r = runScript(repoRoot, ['collect', '2026-02-21', '--days=1', '--max=6'], env);
  assert.strictEqual(r.status, 0, `collect should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(Array.isArray(out.queued));
  assert.ok(out.queued.length >= 1, 'collect should queue at least one signal');

  if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });

  console.log('strategy_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

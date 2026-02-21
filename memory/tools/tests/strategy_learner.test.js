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
  const script = path.join(repoRoot, 'systems', 'strategy', 'strategy_learner.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_learner');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const strategyDir = path.join(tmpRoot, 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const scoreDir = path.join(tmpRoot, 'state', 'adaptive', 'strategy', 'scorecards');
  mkDir(strategyDir);
  mkDir(runsDir);

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'default_general',
    status: 'active',
    objective: { primary: 'test strategy A' },
    risk_policy: { allowed_risks: ['low'] }
  });
  writeJson(path.join(strategyDir, 'alt.json'), {
    version: '1.0',
    id: 'alt_experiment',
    status: 'active',
    objective: { primary: 'test strategy B' },
    risk_policy: { allowed_risks: ['low'] }
  });

  const date = '2026-02-20';
  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', strategy_id: 'default_general', result: 'executed', outcome: 'shipped' },
    { ts: `${date}T01:05:00.000Z`, type: 'autonomy_run', strategy_id: 'default_general', result: 'executed', outcome: 'no_change' },
    { ts: `${date}T01:10:00.000Z`, type: 'autonomy_run', strategy_id: 'default_general', result: 'stop_repeat_gate_interval' },
    { ts: `${date}T01:15:00.000Z`, type: 'autonomy_run', strategy_id: 'alt_experiment', result: 'score_only_evidence' },
    { ts: `${date}T01:20:00.000Z`, type: 'autonomy_run', strategy_id: 'alt_experiment', result: 'score_only_preview' }
  ]);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    STRATEGY_LEARNER_RUNS_DIR: runsDir,
    STRATEGY_SCORECARD_DIR: scoreDir
  };

  let r = runScript(repoRoot, ['run', date, '--days=1', '--persist=1'], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(Array.isArray(out.summaries));
  assert.ok(/^[A-Za-z0-9]+$/.test(String(out.uid || '')), 'scorecard uid should be alnum');

  const primary = out.summaries.find((s) => s.strategy_id === 'default_general');
  const secondary = out.summaries.find((s) => s.strategy_id === 'alt_experiment');
  assert.ok(primary, 'default_general summary missing');
  assert.ok(secondary, 'alt_experiment summary missing');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(primary.uid || '')), 'primary summary uid should be alnum');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(primary.strategy_uid || '')), 'primary strategy uid should be alnum');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(secondary.uid || '')), 'secondary summary uid should be alnum');
  assert.ok(/^[A-Za-z0-9]+$/.test(String(secondary.strategy_uid || '')), 'secondary strategy uid should be alnum');
  assert.strictEqual(primary.stage, 'validated', 'default_general should be validated in this sample');
  assert.strictEqual(secondary.stage, 'theory', 'alt_experiment should remain theory at low attempts');

  const scoreFile = path.join(scoreDir, `${date}.json`);
  assert.ok(fs.existsSync(scoreFile), 'dated scorecard must persist');
  assert.ok(fs.existsSync(path.join(scoreDir, 'latest.json')), 'latest scorecard must persist');

  r = runScript(repoRoot, ['status', 'latest'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.date, date);

  console.log('strategy_learner.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_learner.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

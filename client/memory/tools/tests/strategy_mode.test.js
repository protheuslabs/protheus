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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_mode.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  const strategyDir = path.join(tmpRoot, 'strategies');
  mkDir(strategyDir);
  const strategyPath = path.join(strategyDir, 'default.json');
  const logPath = path.join(tmpRoot, 'strategy_mode_changes.jsonl');

  writeJson(strategyPath, {
    version: '1.0',
    id: 'mode_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_STRATEGY_MODE_LOG: logPath,
    AUTONOMY_STRATEGY_MODE_REQUIRE_POLICY_ROOT: '0'
  };

  let r = runScript(repoRoot, ['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.strategy.mode, 'score_only');

  r = runScript(repoRoot, ['set', '--mode=execute'], env);
  assert.notStrictEqual(r.status, 0, 'set without approval note should fail');

  r = runScript(repoRoot, [
    'set',
    '--mode=canary_execute',
    '--approval-note=approved for promotion',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval for promotion',
    '--force=1'
  ], env);
  assert.strictEqual(r.status, 0, `set canary execute should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.to_mode, 'canary_execute');

  let after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'canary_execute');

  r = runScript(repoRoot, [
    'set',
    '--mode=execute',
    '--approval-note=approved for full execute mode',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval for full execute mode',
    '--force=1'
  ], env);
  assert.strictEqual(r.status, 0, `set execute should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.result, 'mode_changed');
  assert.strictEqual(out.to_mode, 'execute');

  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'execute');

  r = runScript(repoRoot, ['set', '--mode=score_only', '--approval-note=rollback to safe mode'], env);
  assert.strictEqual(r.status, 0, `set score_only should pass: ${r.stderr}`);
  after = readJson(strategyPath);
  assert.strictEqual(after.execution_policy.mode, 'score_only');

  assert.ok(fs.existsSync(logPath), 'audit log should exist');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 2, 'should log both mode changes');

  console.log('strategy_mode.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

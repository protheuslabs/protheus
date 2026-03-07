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

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_mode.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_mode_cooldown');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  const strategyDir = path.join(tmpRoot, 'strategies');
  mkDir(strategyDir);
  const strategyPath = path.join(strategyDir, 'default.json');
  const logPath = path.join(tmpRoot, 'strategy_mode_changes.jsonl');

  writeJson(strategyPath, {
    version: '1.0',
    id: 'cooldown_test',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    AUTONOMY_STRATEGY_MODE_LOG: logPath,
    AUTONOMY_STRATEGY_MODE_MIN_HOURS_BETWEEN_CHANGES: '24',
    AUTONOMY_STRATEGY_MODE_REQUIRE_POLICY_ROOT: '0'
  };

  let r = runScript(repoRoot, [
    'set',
    '--mode=execute',
    '--approval-note=first promote to execute mode',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval first promote',
    '--force=1'
  ], env);
  assert.strictEqual(r.status, 0, `initial forced execute set should pass: ${r.stderr}`);

  r = runScript(repoRoot, [
    'set',
    '--mode=score_only',
    '--approval-note=rollback to score only mode'
  ], env);
  assert.strictEqual(r.status, 0, `rollback to score_only should pass: ${r.stderr}`);

  r = runScript(repoRoot, [
    'set',
    '--mode=execute',
    '--approval-note=second promote to execute mode',
    '--approver-id=owner',
    '--second-approver-id=operator',
    '--second-approval-note=second approval second promote'
  ], env);
  assert.notStrictEqual(r.status, 0, 'cooldown should block immediate re-enable execute');
  const out = parseJson(r.stdout);
  assert.strictEqual(out.error, 'mode_change_cooldown_active');
  assert.ok(Number(out.remaining_minutes || 0) > 0);

  console.log('strategy_mode_cooldown.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_mode_cooldown.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

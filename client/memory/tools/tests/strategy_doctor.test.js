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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_strategy_doctor');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  const strategyDir = path.join(tmpRoot, 'strategies');
  mkDir(strategyDir);

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'test_strategy',
    status: 'active',
    objective: { primary: 'test objective' },
    risk_policy: { allowed_risks: ['low'] },
    execution_policy: { mode: 'score_only' }
  });

  const script = path.join(repoRoot, 'systems', 'autonomy', 'strategy_doctor.js');
  const env = { ...process.env, AUTONOMY_STRATEGY_DIR: strategyDir };
  const r = spawnSync('node', [script, 'run', '--strict'], { cwd: repoRoot, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.active_strategy_id, 'test_strategy');
  assert.strictEqual(out.active_strategy.execution_mode, 'score_only');

  console.log('strategy_doctor.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_doctor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

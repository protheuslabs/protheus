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
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'genome_ledger.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genome-ledger-'));
  const dateStr = '2026-02-25';

  const genomeDir = path.join(tmpRoot, 'state', 'autonomy', 'genome');
  const morphDir = path.join(tmpRoot, 'state', 'autonomy', 'fractal', 'morph_plans');
  writeJson(path.join(morphDir, `${dateStr}.json`), {
    plan_id: 'morph_test',
    objective_id: 'T1_generational_wealth_v1',
    actions: [
      { id: 'a1', kind: 'spawn', target: 'module:autonomy', risk: 'low' }
    ]
  });

  const env = {
    ...process.env,
    FRACTAL_GENOME_DIR: genomeDir,
    FRACTAL_MORPH_PLAN_DIR: morphDir
  };

  const snap1 = spawnSync(process.execPath, [scriptPath, 'snapshot', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(snap1.status, 0, snap1.stderr || 'snapshot should pass');
  const out1 = JSON.parse(String(snap1.stdout || '{}').trim());
  assert.strictEqual(out1.ok, true);

  const snap2 = spawnSync(process.execPath, [scriptPath, 'snapshot', '2026-02-26'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(snap2.status, 0, snap2.stderr || 'second snapshot should pass');

  const verify = spawnSync(process.execPath, [scriptPath, 'verify'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(verify.status, 0, verify.stderr || 'verify should pass');
  const verifyOut = JSON.parse(String(verify.stdout || '{}').trim());
  assert.strictEqual(verifyOut.ok, true);
  assert.strictEqual(verifyOut.valid, true);
  assert.ok(Number(verifyOut.rows || 0) >= 2);

  const status = spawnSync(process.execPath, [scriptPath, 'status'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusOut = JSON.parse(String(status.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.hash);

  console.log('genome_ledger.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`genome_ledger.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

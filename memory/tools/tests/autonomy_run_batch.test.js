#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function parseLastJsonLine(text) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // continue
    }
  }
  return null;
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-run-batch-test-'));
  try {
    const run = spawnSync('node', [
      SCRIPT,
      'run-batch',
      '2026-02-22',
      '--max=2'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTONOMY_ENABLED: '0',
        AUTONOMY_STATE_DIR: path.join(tempRoot, 'autonomy'),
        AUTONOMY_DAILY_BUDGET_DIR: path.join(tempRoot, 'daily_budget')
      }
    });

    assert.strictEqual(run.status, 0, `run-batch should exit 0, stderr=${String(run.stderr || '').trim()}`);
    const payload = parseLastJsonLine(run.stdout);
    assert.ok(payload && typeof payload === 'object', 'run-batch should emit JSON payload');
    assert.strictEqual(String(payload.result), 'batch_complete', 'run-batch should report batch_complete');
    assert.ok(Number(payload.max) === 2, 'run-batch should preserve --max');
    assert.ok(Number(payload.attempted) >= 1, 'run-batch should attempt at least one run');
    assert.ok(Number(payload.attempted) <= 2, 'run-batch should not exceed max');
    assert.ok(Array.isArray(payload.runs), 'run-batch should include per-run rows');
    assert.strictEqual(payload.runs.length, Number(payload.attempted), 'runs length should equal attempted count');
    assert.ok(Number(payload.executed) <= Number(payload.attempted), 'executed count should be bounded by attempts');

    console.log('✅ autonomy_run_batch.test.js PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`❌ autonomy_run_batch.test.js failed: ${err.message}`);
  process.exit(1);
}

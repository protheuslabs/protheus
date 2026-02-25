#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'security', 'black_box_ledger.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'black-box-ledger-'));
  const dateStr = '2026-02-25';

  const spineRunsDir = path.join(tmpRoot, 'state', 'spine', 'runs');
  const autonomyRunsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const ledgerDir = path.join(tmpRoot, 'state', 'security', 'black_box_ledger');
  writeJsonl(path.join(spineRunsDir, `${dateStr}.jsonl`), [
    { ts: `${dateStr}T00:00:00.000Z`, type: 'spine_run_started', mode: 'daily' },
    { ts: `${dateStr}T00:02:00.000Z`, type: 'spine_suggestion_lane', ok: true },
    { ts: `${dateStr}T00:10:00.000Z`, type: 'spine_run_completed', mode: 'daily' }
  ]);
  writeJsonl(path.join(autonomyRunsDir, `${dateStr}.jsonl`), [
    { ts: `${dateStr}T00:05:00.000Z`, type: 'autonomy_run', proposal_id: 'P1', result: 'executed', outcome: 'shipped' },
    { ts: `${dateStr}T00:06:00.000Z`, type: 'autonomy_candidate_audit', proposal_id: 'P2' }
  ]);

  const env = {
    ...process.env,
    BLACK_BOX_LEDGER_DIR: ledgerDir,
    BLACK_BOX_SPINE_RUNS_DIR: spineRunsDir,
    BLACK_BOX_AUTONOMY_RUNS_DIR: autonomyRunsDir
  };

  const rollup = spawnSync(process.execPath, [scriptPath, 'rollup', dateStr, '--mode=daily'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(rollup.status, 0, rollup.stderr || 'rollup should pass');
  const rollupOut = JSON.parse(String(rollup.stdout || '{}').trim());
  assert.strictEqual(rollupOut.ok, true);
  assert.strictEqual(Number(rollupOut.total_events || 0), 5);

  const verify = spawnSync(process.execPath, [scriptPath, 'verify'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(verify.status, 0, verify.stderr || 'verify should pass');
  const verifyOut = JSON.parse(String(verify.stdout || '{}').trim());
  assert.strictEqual(verifyOut.ok, true);
  assert.strictEqual(verifyOut.valid, true);

  const status = spawnSync(process.execPath, [scriptPath, 'status'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusOut = JSON.parse(String(status.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.last_date, dateStr);

  console.log('black_box_ledger.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`black_box_ledger.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

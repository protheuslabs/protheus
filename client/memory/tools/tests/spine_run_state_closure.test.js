#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SPINE = path.join(ROOT, 'systems', 'spine', 'spine.js');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function main() {
  const date = '2099-01-02';
  const ledgerPath = path.join(ROOT, 'state', 'spine', 'runs', `${date}.jsonl`);
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);

  const proc = spawnSync(process.execPath, [SPINE, 'eyes', date, '--max-eyes=0'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTONOMY_ENABLED: '1'
    }
  });
  assert.ok(Number.isInteger(proc.status), 'spine run should produce an exit status');

  const rows = readJsonl(ledgerPath);
  assert.ok(rows.length >= 2, 'ledger should contain start + terminal events');

  const started = rows.filter((row) => row && row.type === 'spine_run_started');
  assert.strictEqual(started.length, 1, 'should emit exactly one spine_run_started for this run');
  const runId = String(started[0].run_id || '');
  assert.ok(runId.length > 0, 'started event should include run_id');

  const terminal = rows.filter((row) => row && (row.type === 'spine_run_complete' || row.type === 'spine_run_failed') && String(row.run_id || '') === runId);
  assert.strictEqual(terminal.length, 1, 'should emit exactly one terminal event for started run_id');

  const t = terminal[0];
  const expectedTerminalType = Number(proc.status) === 0 ? 'spine_run_complete' : 'spine_run_failed';
  assert.strictEqual(String(t.type || ''), expectedTerminalType, 'terminal ledger event should match process exit state');
  assert.ok(Number(t.elapsed_ms || 0) >= 0, 'terminal event should include elapsed_ms');
  assert.ok(String(t.terminal_step || '').length > 0, 'terminal event should include terminal_step');
  assert.ok(t.resource_snapshot && typeof t.resource_snapshot === 'object', 'terminal event should include resource snapshot');

  console.log('spine_run_state_closure.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`spine_run_state_closure.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

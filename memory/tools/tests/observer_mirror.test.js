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

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'observer_mirror.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-mirror-'));
  const dateStr = '2026-02-25';
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const simDir = path.join(tmp, 'state', 'autonomy', 'simulations');
  const introspectionDir = path.join(tmp, 'state', 'autonomy', 'fractal', 'introspection');
  const outDir = path.join(tmp, 'state', 'autonomy', 'observer_mirror');

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel' },
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'external_intel' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'unknown' }
  ]);
  writeJson(path.join(simDir, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.029 },
      yield_rate: { value: 0.68 }
    }
  });
  writeJson(path.join(introspectionDir, `${dateStr}.json`), {
    snapshot: {
      queue: { pressure: 'high' },
      autopause: { active: false }
    },
    restructure_candidates: [{ id: 'n1' }]
  });

  const env = {
    ...process.env,
    OBSERVER_MIRROR_RUNS_DIR: runsDir,
    OBSERVER_MIRROR_SIM_DIR: simDir,
    OBSERVER_MIRROR_INTROSPECTION_DIR: introspectionDir,
    OBSERVER_MIRROR_OUT_DIR: outDir
  };

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr, '--days=1'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'observer run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'observer run output should be ok');
  assert.ok(['stable', 'guarded', 'strained'].includes(String(runOut.mood || '')), 'observer mood should be present');
  assert.strictEqual(runOut.queue_pressure, 'high', 'queue pressure should be surfaced');

  const snapshotPath = path.join(outDir, `${dateStr}.json`);
  assert.ok(fs.existsSync(snapshotPath), 'observer snapshot should be written');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.strictEqual(snapshot.ok, true);
  assert.strictEqual(snapshot.type, 'observer_mirror_run');
  assert.ok(snapshot.observer && snapshot.observer.statement, 'observer statement should be present');

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'observer status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status should be ok');
  assert.ok(statusOut.statement, 'status should return observer statement');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('observer_mirror.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`observer_mirror.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

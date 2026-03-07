#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run(cmd, args, cwd, env = {}) {
  const out = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function parseJsonFromStdout(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

try {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const gateScript = path.join(repoRoot, 'systems', 'personas', 'pre_commit_lens_gate.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-lens-gate-'));
  run('git', ['init'], tmp);

  const safeFile = path.join(tmp, 'safe.ts');
  fs.writeFileSync(safeFile, 'export const stablePath = 1;\n', 'utf8');
  run('git', ['add', 'safe.ts'], tmp);

  let proc = run(process.execPath, [gateScript, '--persona=vikram_menon'], tmp, {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  let payload = parseJsonFromStdout(proc.stdout);
  assert.ok(payload && payload.type === 'pre_commit_lens_gate', 'gate should emit structured payload');
  assert.ok(['low', 'medium'].includes(String(payload.risk_tier || '')), 'safe change should not be high risk');

  fs.writeFileSync(
    safeFile,
    [
      'export const stablePath = 1;',
      'const bypass = true; // disable security gate during migration'
    ].join('\n') + '\n',
    'utf8'
  );
  run('git', ['add', 'safe.ts'], tmp);

  proc = run(process.execPath, [gateScript, '--persona=vikram_menon'], tmp, {
    OPENCLAW_WORKSPACE: tmp
  });
  assert.notStrictEqual(proc.status, 0, 'high-risk change should be blocked');
  payload = parseJsonFromStdout(proc.stdout);
  assert.ok(payload && payload.risk_tier === 'high', 'blocked run should classify as high risk');
  assert.ok(proc.stderr.includes('pre_commit_lens_gate_blocked'), 'blocked run should emit blocking marker');

  const latestPath = path.join(tmp, 'state', 'personas', 'pre_commit_lens_gate', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'personas', 'pre_commit_lens_gate', 'history.jsonl');
  assert.ok(fs.existsSync(latestPath), 'latest receipt should be written');
  assert.ok(fs.existsSync(historyPath), 'history receipts should be written');
  const historyRows = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(historyRows.length >= 2, 'history should contain both safe and blocked receipts');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('pre_commit_lens_gate.test.js: OK');
} catch (err) {
  console.error(`pre_commit_lens_gate.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}

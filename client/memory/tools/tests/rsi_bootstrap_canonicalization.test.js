#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap_canonicalization.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-bootstrap-canon-'));
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'rsi_bootstrap_canonicalization_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'adaptive.rsi.bootstrap_canonicalization' },
    rsi_policy_path: path.join(ROOT, 'config', 'rsi_bootstrap_policy.json'),
    rsi_script: path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js'),
    commands: [
      { id: 'bootstrap', command: 'bootstrap', args: ['--mock=1'], expect_type: 'rsi_bootstrap' },
      { id: 'status', command: 'status', args: ['--mock=1'], expect_type: 'rsi_status' },
      { id: 'step', command: 'step', args: ['--mock=1', '--apply=0', '--target-path=client/systems/ops/protheusctl.ts', '--objective-id=canon_test'], expect_type: 'rsi_step' }
    ],
    paths: {
      memory_dir: path.join(tmp, 'memory', 'adaptive', 'rsi_bootstrap_canonicalization'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'rsi', 'bootstrap_canonicalization', 'index.json'),
      events_path: path.join(stateDir, 'rsi_bootstrap_canonicalization', 'events.jsonl'),
      latest_path: path.join(stateDir, 'rsi_bootstrap_canonicalization', 'latest.json'),
      receipts_path: path.join(stateDir, 'rsi_bootstrap_canonicalization', 'receipts.jsonl'),
      verification_state_path: path.join(stateDir, 'rsi_bootstrap_canonicalization', 'state.json')
    }
  });

  let out = run(['verify', '--owner=jay', '--strict=1', '--apply=1', '--mock=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_bootstrap_canonicalization_verify', 'verify should emit canonicalization event');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(Number(out.payload.verification_runs || 0) >= 1, 'status should show verification history');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_bootstrap_canonicalization.test.js: OK');
} catch (err) {
  console.error(`rsi_bootstrap_canonicalization.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

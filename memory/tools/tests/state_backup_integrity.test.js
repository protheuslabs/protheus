#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'state_backup_integrity.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-integrity-'));
  const destination = path.join(tmp, 'backup');
  const profile = 'runtime_state';
  const snapshotId = '20260302T120000Z';
  const snapshotDir = path.join(destination, profile, snapshotId);
  const policyPath = path.join(tmp, 'config', 'state_backup_integrity_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'state_backup_integrity', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'state_backup_integrity', 'history.jsonl');
  const alertsPath = path.join(tmp, 'state', 'ops', 'state_backup_integrity', 'alerts.jsonl');

  const relPath = 'state/autonomy/runs/sample.jsonl';
  const absFile = path.join(snapshotDir, relPath);
  write(absFile, '{"ok":true}\n');
  writeJson(path.join(snapshotDir, 'manifest.json'), {
    ts: '2026-03-02T12:00:00.000Z',
    type: 'state_backup_snapshot',
    profile,
    snapshot_id: snapshotId,
    file_count: 1,
    files: [{ path: relPath, sha256: sha256(absFile), size_bytes: 13 }]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    profile,
    destination,
    verify_recent_snapshots: 7,
    alert_on_mismatch: true,
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      alerts_path: alertsPath
    }
  });

  const env = {
    STATE_BACKUP_INTEGRITY_ROOT: tmp,
    STATE_BACKUP_INTEGRITY_POLICY_PATH: policyPath
  };

  let out = run(['check', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'check should pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'integrity should pass initially');

  write(absFile, '{"ok":false}\n');
  out = run(['check', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict check should return payload');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'integrity should fail after tamper');
  assert.ok(Number(payload.failed_snapshots || 0) === 1, 'one snapshot should fail');
  assert.ok(fs.existsSync(alertsPath), 'alert log should exist on mismatch');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('state_backup_integrity.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_backup_integrity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

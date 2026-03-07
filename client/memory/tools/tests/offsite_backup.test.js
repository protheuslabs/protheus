#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'offsite_backup.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeText(filePath, body) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return {
    status: typeof r.status === 'number' ? r.status : 1,
    payload,
    stdout: out,
    stderr: String(r.stderr || '')
  };
}

function sha256(input) {
  return require('crypto').createHash('sha256').update(input).digest('hex');
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offsite-backup-test-'));
  const sourceDest = path.join(tmp, 'source');
  const offsiteDest = path.join(tmp, 'offsite');
  const restoreDest = path.join(tmp, 'restore');
  const policyPath = path.join(tmp, 'offsite_backup_policy.json');
  const syncReceipts = path.join(tmp, 'sync_receipts.jsonl');
  const drillReceipts = path.join(tmp, 'drill_receipts.jsonl');

  const profile = 'runtime_state';
  const snapshotId = '20260226T000000Z';
  const snapshotDir = path.join(sourceDest, profile, snapshotId);
  const fileA = 'state/autonomy/runs/2026-02-26.jsonl';
  const fileB = 'state/sensory/proposals/2026-02-26.json';
  const payloadA = '{"ok":true,"id":"a"}\n';
  const payloadB = '{"items":[1,2,3]}\n';

  writeText(path.join(snapshotDir, fileA), payloadA);
  writeText(path.join(snapshotDir, fileB), payloadB);
  writeJson(path.join(snapshotDir, 'manifest.json'), {
    type: 'state_backup_snapshot',
    ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    snapshot_id: snapshotId,
    file_count: 2,
    files: [
      { path: fileA, sha256: sha256(payloadA), size_bytes: Buffer.byteLength(payloadA) },
      { path: fileB, sha256: sha256(payloadB), size_bytes: Buffer.byteLength(payloadB) }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    default_profile: profile,
    source: { destination_default: sourceDest },
    offsite: { destination_default: offsiteDest },
    encryption: { key_env: 'STATE_BACKUP_OFFSITE_KEY' },
    sync: { strict_default: true, verify_write: true, verify_sample_files: 100 },
    restore_drill: {
      strict_default: true,
      cadence_days: 30,
      destination_default: restoreDest,
      rto_target_minutes: 30,
      rpo_target_hours: 24
    }
  });

  const env = {
    OFFSITE_BACKUP_POLICY_PATH: policyPath,
    OFFSITE_BACKUP_SYNC_RECEIPTS_PATH: syncReceipts,
    OFFSITE_BACKUP_DRILL_RECEIPTS_PATH: drillReceipts,
    STATE_BACKUP_OFFSITE_KEY: 'test-secret-key-for-offsite-backup'
  };

  try {
    const sync = run(['sync', '--strict=1'], env);
    assert.strictEqual(sync.status, 0, `sync should pass: ${sync.stderr}`);
    assert.ok(sync.payload && sync.payload.ok === true, 'sync payload should pass');
    const offsiteSnapshotDir = path.join(offsiteDest, profile, snapshotId);
    const offsiteManifestPath = path.join(offsiteSnapshotDir, 'manifest.json');
    assert.ok(fs.existsSync(offsiteManifestPath), 'offsite manifest should exist');
    const offsiteManifest = JSON.parse(fs.readFileSync(offsiteManifestPath, 'utf8'));
    assert.strictEqual(offsiteManifest.type, 'offsite_encrypted_snapshot');
    assert.strictEqual(Number(offsiteManifest.file_count || 0), 2);
    const encPath = path.join(offsiteSnapshotDir, offsiteManifest.files[0].encrypted_path);
    assert.ok(fs.existsSync(encPath), 'encrypted payload should exist');
    const encBody = fs.readFileSync(encPath, 'utf8');
    assert.notStrictEqual(encBody, payloadA, 'encrypted payload should differ from plain text');

    const drill = run(['restore-drill', '--strict=1'], env);
    assert.strictEqual(drill.status, 0, `restore-drill should pass: ${drill.stderr}`);
    assert.ok(drill.payload && drill.payload.ok === true, 'restore drill should pass gates');
    const restoreDir = String(drill.payload.restore_dir || '');
    const restoredA = fs.readFileSync(path.join(restoreDir, 'restored', fileA), 'utf8');
    const restoredB = fs.readFileSync(path.join(restoreDir, 'restored', fileB), 'utf8');
    assert.strictEqual(restoredA, payloadA, 'restored file A should match');
    assert.strictEqual(restoredB, payloadB, 'restored file B should match');

    const status = run(['status'], env);
    assert.strictEqual(status.status, 0, 'status should pass');
    assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
    assert.strictEqual(status.payload.restore_drill_due, false, 'drill should not be due immediately after pass');

    console.log('offsite_backup.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`offsite_backup.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


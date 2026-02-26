#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backup_integrity_check.js');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function writeText(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }

function run(scriptArgs, env) {
  const r = spawnSync('node', [SCRIPT, ...scriptArgs], { encoding: 'utf8', env: { ...process.env, ...env } });
  const out = String(r.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(out); } catch {}
  return { status: r.status ?? 0, payload, stdout: out, stderr: String(r.stderr || '') };
}

function test() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-integrity-'));
  const dest = path.join(tmp, 'backups');
  const profile = 'runtime_state';
  const snapshotId = '20260221T101010Z';
  const snapshotDir = path.join(dest, profile, snapshotId);
  mkdirp(snapshotDir);

  const fileRel = 'state/autonomy/runs/2026-02-21.jsonl';
  const fileAbs = path.join(snapshotDir, fileRel);
  const content = '{"ok":true}\n';
  writeText(fileAbs, content);

  const sha = require('crypto').createHash('sha256').update(content).digest('hex');
  writeJson(path.join(snapshotDir, 'manifest.json'), {
    type: 'state_backup_snapshot',
    snapshot_id: snapshotId,
    files: [{ path: fileRel, sha256: sha }]
  });

  const offsiteProfile = 'runtime_state_offsite';
  const offsiteSnapshotId = '20260221T202020Z';
  const offsiteDir = path.join(dest, offsiteProfile, offsiteSnapshotId);
  mkdirp(offsiteDir);
  const offsiteRel = 'payload/state/autonomy/runs/2026-02-21.jsonl.enc';
  const offsiteAbs = path.join(offsiteDir, offsiteRel);
  writeText(offsiteAbs, 'encrypted-payload');
  const offsiteSha = require('crypto').createHash('sha256').update('encrypted-payload').digest('hex');
  writeJson(path.join(offsiteDir, 'manifest.json'), {
    type: 'offsite_encrypted_snapshot',
    snapshot_id: offsiteSnapshotId,
    files: [{ encrypted_path: offsiteRel, encrypted_sha256: offsiteSha }]
  });

  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    version: '1.0',
    default_channels: ['state_backup'],
    channels: {
      state_backup: {
        destination_default: dest,
        profile,
        manifest_type: 'state_backup_snapshot',
        max_files: 100,
        required: true
      },
      offsite_state_backup: {
        destination_default: dest,
        profile: offsiteProfile,
        manifest_type: 'offsite_encrypted_snapshot',
        max_files: 100,
        required: true
      }
    }
  });

  let r = run(['run', '--channel=state_backup', '--strict'], {
    BACKUP_INTEGRITY_POLICY_PATH: policyPath,
    BACKUP_INTEGRITY_AUDIT_PATH: path.join(tmp, 'audit.jsonl')
  });
  assert.strictEqual(r.status, 0, `expected pass; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'expected ok=true');

  writeText(fileAbs, '{"ok":false}\n');
  r = run(['run', '--channel=state_backup', '--strict'], {
    BACKUP_INTEGRITY_POLICY_PATH: policyPath,
    BACKUP_INTEGRITY_AUDIT_PATH: path.join(tmp, 'audit.jsonl')
  });
  assert.strictEqual(r.status, 1, 'strict mismatch should fail exit=1');
  assert.ok(r.payload && r.payload.ok === false, 'strict mismatch should set ok=false');

  r = run(['run', '--channel=offsite_state_backup', '--strict'], {
    BACKUP_INTEGRITY_POLICY_PATH: policyPath,
    BACKUP_INTEGRITY_AUDIT_PATH: path.join(tmp, 'audit.jsonl')
  });
  assert.strictEqual(r.status, 0, `expected offsite pass; stderr=${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'expected offsite ok=true');

  writeText(offsiteAbs, 'encrypted-payload-corrupt');
  r = run(['run', '--channel=offsite_state_backup', '--strict'], {
    BACKUP_INTEGRITY_POLICY_PATH: policyPath,
    BACKUP_INTEGRITY_AUDIT_PATH: path.join(tmp, 'audit.jsonl')
  });
  assert.strictEqual(r.status, 1, 'strict offsite mismatch should fail exit=1');
  assert.ok(r.payload && r.payload.ok === false, 'strict offsite mismatch should set ok=false');

  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  test();
  console.log('backup_integrity_check.test.js: OK');
} catch (err) {
  console.error(`backup_integrity_check.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

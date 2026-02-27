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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected json stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'workflow', 'data_rights_engine.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-rights-engine-'));

  const policyPath = path.join(tmp, 'config', 'data_rights_policy.json');
  const stateDir = path.join(tmp, 'state', 'workflow', 'data_rights');
  const pendingQueue = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_queue.jsonl');
  const canaryQueue = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_canary.jsonl');
  const masterQueue = path.join(tmp, 'state', 'nursery', 'training', 'continuum_queue.jsonl');
  const datasetsDir = path.join(tmp, 'state', 'nursery', 'training', 'datasets');
  const datasetPath = path.join(datasetsDir, '2026-02-26.jsonl');
  const quarantineStatePath = path.join(tmp, 'state', 'nursery', 'training', 'quarantine_state.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    sla_hours: 12,
    signing: {
      key_id: 'unit_test_key',
      key_env: 'DATA_RIGHTS_SIGNING_KEY',
      dev_fallback_key: 'unit_test_fallback_key'
    },
    queue_paths: {
      pending_queue: pendingQueue,
      canary_queue: canaryQueue,
      master_queue: masterQueue
    },
    checkpoints_index_path: path.join(tmp, 'state', 'nursery', 'training', 'checkpoints', 'index.json'),
    datasets_dir_path: datasetsDir,
    quarantine_state_path: quarantineStatePath,
    defaults: {
      owner_id: 'unit_owner',
      classification: 'internal'
    }
  });

  writeJsonl(pendingQueue, [
    {
      entry_id: 'p1',
      training_conduit: { delete: { key: 'delete_key_alpha' } }
    },
    {
      entry_id: 'p2',
      training_conduit: { delete: { key: 'delete_key_beta' } }
    }
  ]);
  writeJsonl(canaryQueue, [
    {
      entry_id: 'c1',
      training_conduit: { delete: { key: 'delete_key_alpha' } }
    }
  ]);
  writeJsonl(masterQueue, [
    {
      entry_id: 'm1',
      training_conduit: { delete: { key: 'delete_key_alpha' } }
    },
    {
      entry_id: 'm2',
      training_conduit: { delete: { key: 'delete_key_gamma' } }
    }
  ]);
  writeJsonl(datasetPath, [
    {
      row_id: 'd1',
      training_conduit: { delete: { key: 'delete_key_alpha' } },
      payload: 'sensitive alpha row'
    },
    {
      row_id: 'd2',
      training_conduit: { delete: { key: 'delete_key_other' } },
      payload: 'non target row'
    }
  ]);
  writeJson(quarantineStatePath, {
    schema_id: 'training_quarantine_state',
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    checkpoints: {
      p1: {
        checkpoint_id: 'ckpt_p1',
        entry_id: 'p1',
        status: 'promoted'
      },
      p2: {
        checkpoint_id: 'ckpt_p2',
        entry_id: 'p2',
        status: 'canary_running'
      }
    }
  });

  const env = {
    ...process.env,
    DATA_RIGHTS_POLICY_PATH: policyPath,
    DATA_RIGHTS_STATE_DIR: stateDir,
    DATA_RIGHTS_SIGNING_KEY: 'unit_test_real_signing_key'
  };

  const ingest = runNode(scriptPath, [
    'ingest',
    '--datum-id=test_datum_alpha',
    '--delete-key=delete_key_alpha',
    '--source-system=workflow_executor',
    '--source-channel=workflow_outcome',
    '--owner-id=unit_owner',
    '--consent-status=granted',
    '--consent-mode=explicit_opt_in'
  ], env, repoRoot);
  assert.strictEqual(ingest.status, 0, ingest.stderr || ingest.stdout);
  const ingestOut = parseJson(ingest, 'ingest');
  assert.strictEqual(ingestOut.ok, true);
  assert.strictEqual(ingestOut.delete_key, 'delete_key_alpha');

  const revoke = runNode(scriptPath, [
    'revoke',
    '--delete-key=delete_key_alpha',
    '--owner-id=unit_owner',
    '--reason=consent_revoked_user_request'
  ], env, repoRoot);
  assert.strictEqual(revoke.status, 0, revoke.stderr || revoke.stdout);
  const revokeOut = parseJson(revoke, 'revoke');
  assert.strictEqual(revokeOut.ok, true);
  assert.ok(String(revokeOut.request_id || '').startsWith('drq_'));

  const processSim = runNode(scriptPath, ['process', '--apply=0'], env, repoRoot);
  assert.strictEqual(processSim.status, 0, processSim.stderr || processSim.stdout);
  const processSimOut = parseJson(processSim, 'process_sim');
  assert.strictEqual(processSimOut.ok, true);
  assert.strictEqual(processSimOut.processed_count, 1);
  assert.strictEqual(processSimOut.processed[0].status, 'simulated');

  const revoke2 = runNode(scriptPath, [
    'revoke',
    '--delete-key=delete_key_alpha',
    '--owner-id=unit_owner',
    '--reason=consent_revoked_apply_path'
  ], env, repoRoot);
  assert.strictEqual(revoke2.status, 0, revoke2.stderr || revoke2.stdout);

  const processApply = runNode(scriptPath, [
    'process',
    '--apply=1',
    '--actor-id=privacy_test_operator',
    '--actor-roles=privacy_officer',
    '--mfa-token=otp_654321',
    '--tenant-id=tenant_alpha'
  ], env, repoRoot);
  assert.strictEqual(processApply.status, 0, processApply.stderr || processApply.stdout);
  const processApplyOut = parseJson(processApply, 'process_apply');
  assert.strictEqual(processApplyOut.ok, true);
  assert.strictEqual(processApplyOut.processed_count, 1);
  assert.strictEqual(processApplyOut.processed[0].status, 'processed');
  assert.ok(Number(processApplyOut.processed[0].affected_rows || 0) >= 3);
  assert.ok(Number(processApplyOut.processed[0].dataset_rows_removed || 0) >= 1);
  assert.ok(Number(processApplyOut.processed[0].checkpoints_marked_unlearned || 0) >= 1);

  const pendingRows = String(fs.readFileSync(pendingQueue, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.strictEqual(pendingRows.length, 1, 'one pending row should remain after apply');
  assert.strictEqual(
    pendingRows[0].training_conduit.delete.key,
    'delete_key_beta',
    'only non-target delete key should remain'
  );
  const datasetRows = String(fs.readFileSync(datasetPath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.strictEqual(datasetRows.length, 1, 'dataset should retain only non-target rows');
  assert.strictEqual(datasetRows[0].training_conduit.delete.key, 'delete_key_other');
  const quarantineState = JSON.parse(fs.readFileSync(quarantineStatePath, 'utf8'));
  assert.strictEqual(
    quarantineState.checkpoints.p1.status,
    'unlearned',
    'matching checkpoint should be marked unlearned'
  );
  assert.strictEqual(
    quarantineState.checkpoints.p2.status,
    'canary_running',
    'non-matching checkpoint should remain unchanged'
  );

  const rightsEvents = String(fs.readFileSync(path.join(stateDir, 'rights_events.jsonl'), 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(rightsEvents.length >= 3, 'expected signed rights events');
  assert.ok(
    rightsEvents.every((row) => row.signature && row.signature.key_id && row.signature.signature),
    'all rights events should be signed'
  );

  const status = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.counts.processed || 0) >= 1);
  assert.ok(Number(statusOut.counts.provenance_rows || 0) >= 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('data_rights_engine.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`data_rights_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

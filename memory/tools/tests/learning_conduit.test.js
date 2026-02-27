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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'learning_conduit.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-conduit-'));
  const policyPath = path.join(tmp, 'config', 'learning_conduit_policy.json');
  const statePath = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'receipts.jsonl');
  const latestPath = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'latest.json');
  const runPayloadPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const pendingQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_queue.jsonl');
  const canaryQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'workflow_learning_canary.jsonl');
  const masterQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'continuum_queue.jsonl');
  const dataRightsPolicyPath = path.join(tmp, 'config', 'data_rights_policy.json');
  const dataRightsStateDir = path.join(tmp, 'state', 'workflow', 'data_rights');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    proposal_only: true,
    metadata_strict: true,
    trainability_strict: true,
    require_explicit_consent: true,
    queue_paths: {
      pending_queue: pendingQueuePath,
      canary_queue: canaryQueuePath,
      master_queue: masterQueuePath
    },
    canary: {
      required: true,
      min_score: 0.7
    },
    defaults: {
      owner_id: 'ops_owner',
      owner_type: 'human_operator',
      license_id: 'internal_protheus',
      consent_status: 'granted',
      consent_mode: 'explicit_opt_in',
      consent_evidence_ref: 'config/training_conduit_policy.json',
      retention_days: 365,
      delete_scope: 'workflow_learning_conduit'
    }
  });
  writeJson(dataRightsPolicyPath, {
    version: '1.0-test',
    enabled: true,
    sla_hours: 24,
    signing: {
      key_id: 'learning_test',
      key_env: 'DATA_RIGHTS_SIGNING_KEY',
      dev_fallback_key: 'learning_test_fallback'
    },
    queue_paths: {
      pending_queue: pendingQueuePath,
      canary_queue: canaryQueuePath,
      master_queue: masterQueuePath
    },
    checkpoints_index_path: path.join(tmp, 'state', 'nursery', 'training', 'checkpoints', 'index.json'),
    defaults: {
      owner_id: 'ops_owner',
      classification: 'internal_runtime'
    }
  });

  writeJson(runPayloadPath, {
    ok: true,
    run_id: 'wfexec_test_001',
    results: [
      {
        workflow_id: 'wf_alpha',
        status: 'succeeded',
        ok: true,
        duration_ms: 1200,
        mutation_summary: { applied: 1 }
      },
      {
        workflow_id: 'wf_beta',
        status: 'failed',
        ok: false,
        failure_reason: 'gate_blocked',
        blocked_by_gate: true,
        duration_ms: 950
      }
    ]
  });

  const env = {
    ...process.env,
    LEARNING_CONDUIT_POLICY_PATH: policyPath,
    LEARNING_CONDUIT_STATE_PATH: statePath,
    LEARNING_CONDUIT_RECEIPTS_PATH: receiptsPath,
    LEARNING_CONDUIT_LATEST_PATH: latestPath,
    DATA_RIGHTS_POLICY_PATH: dataRightsPolicyPath,
    DATA_RIGHTS_STATE_DIR: dataRightsStateDir,
    DATA_RIGHTS_SIGNING_KEY: 'learning_conduit_data_rights_secret'
  };

  const ingest = runNode(scriptPath, [
    'ingest',
    `--run-payload=${runPayloadPath}`,
    '--consent-status=granted',
    '--consent-mode=explicit_opt_in'
  ], env, root);
  assert.strictEqual(ingest.status, 0, ingest.stderr || ingest.stdout);
  const ingestOut = parseJson(ingest, 'ingest');
  assert.strictEqual(ingestOut.ok, true);
  assert.strictEqual(Number(ingestOut.ingested || 0), 2);
  assert.strictEqual(Number(ingestOut.rejected || 0), 0);
  assert.strictEqual(Number(ingestOut.rights_events_written || 0), 2);
  const provenancePath = path.join(dataRightsStateDir, 'provenance.jsonl');
  assert.ok(fs.existsSync(provenancePath), 'provenance log should be written');
  const provenanceRows = fs.readFileSync(provenancePath, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(provenanceRows.length, 2, 'expected provenance rows for ingested outcomes');

  const status = runNode(scriptPath, ['status'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(Number(statusOut.counts.pending_canary || 0), 2);

  const state = readJson(statePath);
  const entryIds = Object.keys(state.entries || {});
  assert.ok(entryIds.length >= 2, 'state should contain queued entries');
  const promoteId = entryIds[0];

  const blockedPromote = runNode(scriptPath, [
    'promote',
    `--entry-id=${promoteId}`,
    '--canary-pass=0',
    '--canary-score=0.9',
    '--apply=1',
    '--actor-id=learning_test_operator',
    '--actor-roles=ml_operator',
    '--mfa-token=otp_123456',
    '--tenant-id=tenant_alpha'
  ], env, root);
  assert.notStrictEqual(blockedPromote.status, 0, 'promotion should fail when canary-pass is false');
  const blockedOut = parseJson(blockedPromote, 'promote_blocked');
  assert.strictEqual(blockedOut.ok, false);
  assert.ok(blockedOut.blocked.includes('canary_pass_required'));

  const promote = runNode(scriptPath, [
    'promote',
    `--entry-id=${promoteId}`,
    '--canary-pass=1',
    '--canary-score=0.92',
    '--apply=1',
    '--actor-id=learning_test_operator',
    '--actor-roles=ml_operator',
    '--mfa-token=otp_123456',
    '--tenant-id=tenant_alpha'
  ], env, root);
  assert.strictEqual(promote.status, 0, promote.stderr || promote.stdout);
  const promoteOut = parseJson(promote, 'promote');
  assert.strictEqual(promoteOut.ok, true);

  assert.ok(fs.existsSync(masterQueuePath), 'master queue should be written on promotion');
  const masterRows = fs.readFileSync(masterQueuePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(masterRows.some((row) => row && row.entry_id === promoteId && row.stage === 'promoted'));
}

run();

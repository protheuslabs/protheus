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
  const masterTransmitQueuePath = path.join(tmp, 'state', 'nursery', 'training', 'master_llm_ingest_queue.jsonl');
  const masterTransmitReceiptsPath = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'master_transmit_receipts.jsonl');
  const instanceOptOutRegistryPath = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'instance_opt_out_registry.json');
  const hereditaryQueuePath = path.join(tmp, 'state', 'brain', 'hereditary_advancement_queue.jsonl');
  const masterReviewQueuePath = path.join(tmp, 'state', 'brain', 'master_review_advancement_queue.jsonl');
  const dataRightsPolicyPath = path.join(tmp, 'config', 'data_rights_policy.json');
  const dataRightsStateDir = path.join(tmp, 'state', 'workflow', 'data_rights');

  writeJson(instanceOptOutRegistryPath, { entries: {} });
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
    master_conduit: {
      enabled: true,
      default_transmit: true,
      shadow_only: true,
      require_redaction: true,
      queue_path: masterTransmitQueuePath,
      receipts_path: masterTransmitReceiptsPath,
      opt_out_registry_path: instanceOptOutRegistryPath,
      instance_id_env_keys: ['PROTHEUS_INSTANCE_ID']
    },
    federation: {
      mode: 'hereditary_master_reviewed',
      peer_to_peer_network_effect: false,
      hereditary_update_queue_path: hereditaryQueuePath,
      master_review_queue_path: masterReviewQueuePath
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
    PROTHEUS_INSTANCE_ID: 'instance_alpha',
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
  assert.strictEqual(Number(ingestOut.master_conduit && ingestOut.master_conduit.transmitted || 0), 2);
  assert.strictEqual(Number(ingestOut.federation && ingestOut.federation.hereditary_queued || 0), 2);
  assert.ok(fs.existsSync(masterTransmitQueuePath), 'master transmit queue should be written');
  assert.ok(fs.existsSync(hereditaryQueuePath), 'hereditary queue should be written');
  assert.ok(fs.existsSync(masterReviewQueuePath), 'master review queue should be written');
  const provenancePath = path.join(dataRightsStateDir, 'provenance.jsonl');
  assert.ok(fs.existsSync(provenancePath), 'provenance log should be written');
  const provenanceRows = fs.readFileSync(provenancePath, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(provenanceRows.length, 2, 'expected provenance rows for ingested outcomes');

  // Explicit per-instance opt-out should suppress transmit while keeping local queues active.
  writeJson(instanceOptOutRegistryPath, {
    entries: {
      instance_alpha: {
        opt_out: true,
        reason: 'test_opt_out',
        updated_at: new Date().toISOString()
      }
    }
  });
  writeJson(runPayloadPath, {
    ok: true,
    run_id: 'wfexec_test_002',
    results: [
      {
        workflow_id: 'wf_gamma',
        status: 'succeeded',
        ok: true,
        duration_ms: 640,
        mutation_summary: { applied: 0 }
      }
    ]
  });
  const ingestOptOut = runNode(scriptPath, [
    'ingest',
    `--run-payload=${runPayloadPath}`,
    '--consent-status=granted',
    '--consent-mode=explicit_opt_in'
  ], env, root);
  assert.strictEqual(ingestOptOut.status, 0, ingestOptOut.stderr || ingestOptOut.stdout);
  const ingestOptOutOut = parseJson(ingestOptOut, 'ingest_opt_out');
  assert.strictEqual(Boolean(ingestOptOutOut.master_conduit && ingestOptOutOut.master_conduit.explicitly_opted_out), true);
  assert.strictEqual(Number(ingestOptOutOut.master_conduit && ingestOptOutOut.master_conduit.transmitted || 0), 0);

  const status = runNode(scriptPath, ['status'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(Number(statusOut.counts.pending_canary || 0), 3);

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

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

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'learning_conduit.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-conduit-redaction-'));

  const policyPath = path.join(tmp, 'config', 'learning_conduit_policy.json');
  const redactionPolicyPath = path.join(tmp, 'config', 'redaction_classification_policy.json');
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
    redaction_classification: {
      enabled: true,
      strict_block: true,
      policy_path: redactionPolicyPath
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

  writeJson(redactionPolicyPath, {
    version: '1.0-test',
    enabled: true,
    max_text_bytes: 4096,
    redact_on_block: true,
    text_fields_allowlist: ['failure_reason', 'message', 'stderr', 'stdout'],
    rules: [
      {
        id: 'email',
        category: 'pii',
        action: 'redact',
        regex: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
        flags: 'gi'
      },
      {
        id: 'secret_assignment',
        category: 'secret',
        action: 'block',
        regex: '(?:api[_-]?key|token)\\s*[:=]\\s*[A-Za-z0-9_\\-]{8,}',
        flags: 'gi'
      }
    ]
  });

  writeJson(dataRightsPolicyPath, {
    version: '1.0-test',
    enabled: true,
    sla_hours: 24,
    signing: {
      key_id: 'learning_redaction_test',
      key_env: 'DATA_RIGHTS_SIGNING_KEY',
      dev_fallback_key: 'learning_redaction_test_fallback'
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
    run_id: 'wfexec_redaction_001',
    results: [
      {
        workflow_id: 'wf_contact',
        status: 'failed',
        ok: false,
        failure_reason: 'Send details to jane@example.com'
      },
      {
        workflow_id: 'wf_secret',
        status: 'failed',
        ok: false,
        failure_reason: 'api_key=abcd1234efgh5678'
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
    DATA_RIGHTS_SIGNING_KEY: 'learning_conduit_redaction_secret'
  };

  const proc = spawnSync(process.execPath, [
    scriptPath,
    'ingest',
    `--run-payload=${runPayloadPath}`,
    '--consent-status=granted',
    '--consent-mode=explicit_opt_in'
  ], {
    cwd: root,
    env,
    encoding: 'utf8'
  });

  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  const out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'ingest should succeed');
  assert.strictEqual(Number(out.ingested || 0), 1, 'one row should be ingested');
  assert.strictEqual(Number(out.rejected || 0), 1, 'one row should be rejected');
  assert.ok(out.redaction_summary, 'redaction summary should be present');
  assert.strictEqual(Number(out.redaction_summary.blocked_rows || 0), 1);
  assert.strictEqual(Number(out.redaction_summary.redacted_rows || 0) >= 1, true);

  const pendingRows = fs.readFileSync(pendingQueuePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.strictEqual(pendingRows.length, 1, 'pending queue should hold only the non-blocked row');
  assert.strictEqual(pendingRows[0].redaction.redacted, true, 'pending row should be redacted');
  assert.strictEqual(
    String(pendingRows[0].learning_text || '').includes('[REDACTED:pii]'),
    true,
    'pending row should contain redacted pii marker'
  );

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const entries = Object.values(state.entries || {});
  const blocked = entries.find((row) => row && row.workflow_id === 'wf_secret');
  assert.ok(blocked, 'blocked row should exist in state');
  assert.ok(Array.isArray(blocked.reasons) && blocked.reasons.includes('sensitive_content_blocked'));

  console.log('learning_conduit_redaction.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`learning_conduit_redaction.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

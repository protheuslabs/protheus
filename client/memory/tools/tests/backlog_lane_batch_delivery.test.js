#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_lane_batch_delivery.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : null;
}

function statusCode(result) {
  return Number.isFinite(Number(result && result.status)) ? Number(result.status) : 1;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-lane-batch-'));
  const policyPath = path.join(tmp, 'policy.json');
  const registryPath = path.join(tmp, 'registry.json');
  const reviewRegistryPath = path.join(tmp, 'review.json');
  const stateDir = path.join(tmp, 'state');
  const targetId = 'V2-012';

  writeJson(registryPath, {
    schema_id: 'backlog_registry',
    schema_version: '1.0',
    rows: [
      {
        id: targetId,
        class: 'backlog',
        wave: 'V2',
        status: 'done',
        title: 'Test row',
        acceptance: 'verify rollback',
        dependencies: []
      }
    ]
  });

  writeJson(reviewRegistryPath, {
    schema_id: 'backlog_review_registry_v1',
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    rows: [
      {
        id: targetId,
        status: 'done',
        review_result: 'pass',
        evidence: {
          substantive_code_paths: ['client/systems/ops/backlog_lane_batch_delivery.ts']
        }
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_default: true,
    source_registry_path: registryPath,
    review_registry_path: reviewRegistryPath,
    require_review_pass: true,
    done_statuses: ['done'],
    targets: {
      [targetId]: {
        require_dependency_closed: false,
        verify_signals_required: false,
        rollback_signals_required: false,
        notes: 'test_target'
      }
    },
    outputs: {
      state_dir: stateDir,
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl')
    }
  });

  const env = { BACKLOG_LANE_BATCH_DELIVERY_POLICY_PATH: policyPath };

  const listRes = run(['list'], env);
  assert.strictEqual(statusCode(listRes), 0, String(listRes.stderr || ''));
  const listPayload = parseJson(listRes.stdout);
  assert.ok(listPayload && listPayload.ok === true, 'list should be ok');
  assert.strictEqual(Number(listPayload.target_count || 0), 1, 'one target expected');

  const runRes = run(['run', `--id=${targetId}`, '--apply=1', '--strict=1'], env);
  assert.strictEqual(statusCode(runRes), 0, String(runRes.stderr || ''));
  const runPayload = parseJson(runRes.stdout);
  assert.ok(runPayload && runPayload.ok === true, 'run should pass');
  assert.strictEqual(String(runPayload.id || '').toUpperCase(), targetId, 'target id should match');
  assert.ok(Array.isArray(runPayload.checks), 'checks should exist');
  assert.ok(runPayload.checks.some((check) => check.id === 'implementation_review_pass' && check.pass === true), 'review pass check should pass');

  const statusRes = run(['status', `--id=${targetId}`], env);
  assert.strictEqual(statusCode(statusRes), 0, String(statusRes.stderr || ''));
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should be ok');
  assert.ok(statusPayload.state && String(statusPayload.state.id || '').toUpperCase() === targetId, 'status state id should match');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`backlog_lane_batch_delivery.test.js: OK (${targetId})`);
} catch (err) {
  console.error(`backlog_lane_batch_delivery.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

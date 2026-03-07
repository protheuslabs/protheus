#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_queue_executor.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: Number.isFinite(Number(result.status)) ? Number(result.status) : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-queue-executor-'));
  const policyPath = path.join(tmp, 'policy.json');
  const registryPath = path.join(tmp, 'registry.json');
  const reviewPath = path.join(tmp, 'review.json');
  const stateRoot = path.join(tmp, 'state');

  writeJson(registryPath, {
    schema_id: 'backlog_registry',
    schema_version: '1.0',
    rows: [
      {
        id: 'V9-UNWIRED-001',
        class: 'backlog',
        wave: 'V6',
        status: 'queued',
        title: 'Missing real lane',
        dependencies: []
      }
    ]
  });

  writeJson(reviewPath, {
    schema_id: 'backlog_review_registry_v1',
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    rows: [
      {
        id: 'V9-UNWIRED-001',
        status: 'queued',
        review_result: 'pass',
        evidence: {
          substantive_code_paths: ['client/systems/ops/backlog_queue_executor.ts']
        }
      }
    ]
  });

  writeJson(policyPath, {
    schema_id: 'backlog_queue_executor_policy',
    schema_version: '1.0-test',
    enabled: true,
    registry_path: registryPath,
    review_registry_path: reviewPath,
    enforce_real_delivery: true,
    require_review_pass: true,
    require_lane_test: true,
    pseudo_lane_markers: ['backlog_lane_batch_delivery', 'backlog_queue_executor'],
    state_root: stateRoot,
    latest_path: path.join(stateRoot, 'latest.json'),
    history_path: path.join(stateRoot, 'history.jsonl'),
    sqlite: {
      enabled: true,
      db_path: path.join(stateRoot, 'queue.db'),
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
      busy_timeout_ms: 8000,
      queue_name: 'backlog_queue_executor',
      migrate_history_jsonl: true,
      mirror_jsonl: true
    }
  });

  const runNonStrict = run(['run', '--all=1', `--policy=${policyPath}`, '--strict=0']);
  assert.strictEqual(runNonStrict.status, 0, `run (strict=0) failed unexpectedly: ${runNonStrict.stderr}`);
  const payload = parseJson(runNonStrict.stdout);
  assert.ok(payload, 'expected run payload');
  assert.strictEqual(payload.ok, false, 'run should fail-close when real lane deliverable is missing');
  assert.strictEqual(Number(payload.executed_count || 0), 0, 'no rows should execute');
  assert.strictEqual(Number(payload.blocked_count || 0), 1, 'row should be blocked');
  assert.ok(Array.isArray(payload.blocked_ids) && payload.blocked_ids.includes('V9-UNWIRED-001'), 'blocked row should be reported');

  const runStrict = run(['run', '--all=1', `--policy=${policyPath}`, '--strict=1']);
  assert.notStrictEqual(runStrict.status, 0, 'strict mode should fail when execution is blocked');

  const statusRes = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(statusRes.status, 0, `status failed: ${statusRes.stderr}`);
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status should be ok');
  assert.ok(statusPayload.latest && statusPayload.latest.ok === false, 'status.latest should reflect blocked execution');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('backlog_queue_executor.test.js: OK');
} catch (err) {
  console.error(`backlog_queue_executor.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_queue_executor.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected JSON stdout');
  return JSON.parse(txt);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-queue-executor-'));
  const policyPath = path.join(tmp, 'backlog_queue_executor_policy.json');
  const registryPath = path.join(tmp, 'backlog_registry.json');
  const stateRoot = path.join(tmp, 'state');

  writeJson(registryPath, {
    schema_id: 'backlog_registry',
    schema_version: '1.0',
    rows: [
      {
        id: 'V3-RACE-195',
        class: 'hardening',
        wave: 'V3',
        status: 'queued',
        title: 'Red-Team Discovery Propagation Fabric',
        dependencies: []
      },
      {
        id: 'V3-RACE-216',
        class: 'hardening',
        wave: 'V3',
        status: 'queued',
        title: 'Monorepo Build-Graph Modernization',
        dependencies: []
      },
      {
        id: 'V3-RACE-001',
        class: 'hardening',
        wave: 'V3',
        status: 'done',
        title: 'Already done row',
        dependencies: []
      }
    ]
  });

  writeJson(policyPath, {
    schema_id: 'backlog_queue_executor_policy',
    schema_version: '1.0-test',
    enabled: true,
    registry_path: registryPath,
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

  const runAll = run(['run', '--all=1', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(runAll.status, 0, `run all failed: ${runAll.stderr}`);
  const runPayload = parseJson(runAll.stdout);
  assert.strictEqual(runPayload.ok, true, 'run payload should be ok');
  assert.strictEqual(Number(runPayload.executed_count), 2, 'should execute queued rows only');
  assert.ok(Array.isArray(runPayload.executed_ids), 'executed ids should be array');
  assert.ok(runPayload.executed_ids.includes('V3-RACE-195'), 'should include V3-RACE-195');
  assert.ok(runPayload.executed_ids.includes('V3-RACE-216'), 'should include V3-RACE-216');
  assert.ok(runPayload.sqlite && runPayload.sqlite.enabled === true, 'sqlite should be enabled');
  assert.ok(runPayload.sqlite.stats && Number(runPayload.sqlite.stats.events) >= 2, 'sqlite should record queue events');

  const receiptA = path.join(stateRoot, 'receipts', 'V3-RACE-195.json');
  const receiptB = path.join(stateRoot, 'receipts', 'V3-RACE-216.json');
  assert.ok(fs.existsSync(receiptA), 'receipt A should exist');
  assert.ok(fs.existsSync(receiptB), 'receipt B should exist');

  const statusRes = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(statusRes.status, 0, `status failed: ${statusRes.stderr}`);
  const statusPayload = parseJson(statusRes.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status payload should be ok');
  assert.ok(statusPayload.latest, 'status should include latest');
  assert.ok(statusPayload.sqlite && statusPayload.sqlite.enabled === true, 'status should include sqlite state');

  const runIds = run(['run', '--ids=V3-RACE-195', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(runIds.status, 0, `run ids failed: ${runIds.stderr}`);
  const runIdsPayload = parseJson(runIds.stdout);
  assert.strictEqual(Number(runIdsPayload.executed_count), 1, 'explicit IDs should execute one row');

  const dbPath = path.join(stateRoot, 'queue.db');
  assert.ok(fs.existsSync(dbPath), 'sqlite db should exist');
  const db = new DatabaseSync(dbPath);
  const itemCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_items').get().count || 0);
  const eventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_events').get().count || 0);
  const receiptCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_receipts').get().count || 0);
  assert.ok(itemCount >= 2, 'sqlite should persist queue items');
  assert.ok(eventCount >= 3, 'sqlite should persist queue events');
  assert.ok(receiptCount >= 3, 'sqlite should persist receipts');
  db.close();

  console.log('backlog_queue_executor.test.js: OK');
} catch (err) {
  console.error(`backlog_queue_executor.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

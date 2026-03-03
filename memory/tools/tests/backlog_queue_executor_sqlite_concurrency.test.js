#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('close', (code) => {
      resolve({
        status: Number.isFinite(Number(code)) ? Number(code) : 1,
        stdout,
        stderr
      });
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-queue-executor-concurrency-'));
  const policyPath = path.join(tmp, 'backlog_queue_executor_policy.json');
  const registryPath = path.join(tmp, 'backlog_registry.json');
  const stateRoot = path.join(tmp, 'state');

  writeJson(registryPath, {
    schema_id: 'backlog_registry',
    schema_version: '1.0',
    rows: [
      { id: 'V3-RACE-195', class: 'hardening', wave: 'V3', status: 'queued', title: 'Lane A', dependencies: [] },
      { id: 'V3-RACE-196', class: 'hardening', wave: 'V3', status: 'queued', title: 'Lane B', dependencies: [] },
      { id: 'V3-RACE-197', class: 'hardening', wave: 'V3', status: 'queued', title: 'Lane C', dependencies: [] },
      { id: 'V3-RACE-198', class: 'hardening', wave: 'V3', status: 'queued', title: 'Lane D', dependencies: [] }
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

  const env = {};
  const runners = [
    runAsync(['run', '--ids=V3-RACE-195', `--policy=${policyPath}`, '--strict=1'], env),
    runAsync(['run', '--ids=V3-RACE-196', `--policy=${policyPath}`, '--strict=1'], env),
    runAsync(['run', '--ids=V3-RACE-197', `--policy=${policyPath}`, '--strict=1'], env),
    runAsync(['run', '--ids=V3-RACE-198', `--policy=${policyPath}`, '--strict=1'], env)
  ];

  const results = await Promise.all(runners);
  for (const result of results) {
    assert.strictEqual(result.status, 0, `concurrent run failed: ${result.stderr || result.stdout}`);
  }

  const dbPath = path.join(stateRoot, 'queue.db');
  assert.ok(fs.existsSync(dbPath), 'queue db should exist after concurrent runs');
  const db = new DatabaseSync(dbPath);
  const eventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_events').get().count || 0);
  const receiptCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_receipts').get().count || 0);
  const itemCount = Number(db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_items').get().count || 0);
  assert.ok(eventCount >= 4, 'sqlite event stream should retain concurrent writes');
  assert.ok(receiptCount >= 4, 'sqlite receipt table should retain concurrent writes');
  assert.ok(itemCount >= 4, 'sqlite queue item table should retain concurrent writes');
  db.close();

  console.log('backlog_queue_executor_sqlite_concurrency.test.js: OK');
}

main().catch((err) => {
  console.error(`backlog_queue_executor_sqlite_concurrency.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

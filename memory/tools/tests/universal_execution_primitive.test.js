#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'actuation', 'universal_execution_primitive.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-primitive-'));
  const receiptsRoot = path.join(tmp, 'receipts');
  const outboxRoot = path.join(tmp, 'outbox');
  const fsRoot = path.join(tmp, 'fs');
  const profileRoot = path.join(tmp, 'profiles');
  ensureDir(receiptsRoot);
  ensureDir(outboxRoot);
  ensureDir(fsRoot);
  ensureDir(profileRoot);

  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    min_profile_confidence: 0.5,
    default_adapter_kind: 'http_request',
    allowed_adapter_kinds: [],
    profile_roots: [profileRoot],
    source_type_adapter_map: {
      api: 'http_request',
      filesystem: 'filesystem_task'
    },
    intent_adapter_map: {
      write_file: 'filesystem_task'
    },
    receipts_path: receiptsRoot
  });

  const apiProfilePath = path.join(profileRoot, 'api_profile.json');
  writeJson(apiProfilePath, {
    profile_id: 'api_profile',
    source: { source_type: 'api' },
    provenance: { confidence: 0.9 }
  });
  const fsProfilePath = path.join(profileRoot, 'fs_profile.json');
  writeJson(fsProfilePath, {
    profile_id: 'fs_profile',
    source: { source_type: 'filesystem' },
    execution: { adapter_kind: 'filesystem_task' },
    provenance: { confidence: 0.95 }
  });

  const env = {
    UNIVERSAL_EXECUTION_POLICY_PATH: policyPath,
    ACTUATION_ADAPTER_OUTBOX_ROOT: outboxRoot,
    ACTUATION_FILESYSTEM_ROOT: fsRoot,
    ACTUATION_RECEIPTS_DIR: path.join(tmp, 'actuation_receipts')
  };

  const dry = run([
    'run',
    '--profile-id=api_profile',
    '--params={"url":"https://example.com/hook","method":"POST","body":{"ok":true}}',
    '--context={"passport_id":"passport-123"}',
    '--dry-run'
  ], env);
  assert.strictEqual(dry.status, 0, `dry run failed: ${dry.stderr || dry.stdout}`);
  const dryPayload = parseJson(dry.stdout);
  assert.strictEqual(dryPayload.ok, true, 'dry payload not ok');
  assert.strictEqual(dryPayload.adapter_kind, 'http_request', 'api profile should map to http_request');
  assert.strictEqual(dryPayload.row.passport_link_id, 'passport-123', 'passport link should propagate');

  const live = run([
    'run',
    '--profile-id=fs_profile',
    '--intent=write_file',
    '--params={"action":"write_file","path":"notes/universal.txt","content":"universal primitive live write"}'
  ], env);
  assert.strictEqual(live.status, 0, `live run failed: ${live.stderr || live.stdout}`);
  const livePayload = parseJson(live.stdout);
  assert.strictEqual(livePayload.ok, true, 'live payload not ok');
  assert.strictEqual(livePayload.adapter_kind, 'filesystem_task', 'fs profile should map to filesystem adapter');

  const writtenPath = path.join(fsRoot, 'notes', 'universal.txt');
  assert.ok(fs.existsSync(writtenPath), 'filesystem write should execute');
  assert.ok(fs.readFileSync(writtenPath, 'utf8').includes('universal primitive'), 'written file should contain payload');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, `status failed: ${status.stderr || status.stdout}`);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status payload not ok');
  assert.ok(Number(statusPayload.total_runs || 0) >= 2, 'status should count runs');
  assert.strictEqual(Number(statusPayload.profile_only_ratio || 0), 1, 'all runs should be profile-based');

  const receiptFile = path.join(receiptsRoot, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const receipts = readJsonl(receiptFile);
  assert.ok(receipts.length >= 2, 'receipts should be written');
  assert.ok(receipts.every((row) => row && row.profile_id), 'receipts should carry profile id');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('universal_execution_primitive.test.js: OK');
} catch (err) {
  console.error(`universal_execution_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

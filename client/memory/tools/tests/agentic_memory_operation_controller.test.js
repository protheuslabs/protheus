#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'agentic_memory_operation_controller.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(policyPath, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      V3_RACE_163_POLICY_PATH: policyPath
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-memory-'));
  const policyPath = path.join(tmp, 'config', 'agentic_memory_operation_policy.json');

  writeJson(policyPath, {
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'memory.agentic_ops' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'memory_ops'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'memory_ops', 'index.json'),
      events_path: path.join(tmp, 'state', 'memory', 'agentic_ops', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'memory', 'agentic_ops', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'memory', 'agentic_ops', 'receipts.jsonl')
    }
  });

  let res = run(policyPath, ['configure', '--owner=test_owner', '--profile=default']);
  assert.strictEqual(res.status, 0, `configure should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.action === 'configure');

  res = run(policyPath, ['execute', '--owner=test_owner', '--task=cleanup', '--approved=1']);
  assert.strictEqual(res.status, 0, `execute should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.action === 'record');
  assert.strictEqual(res.payload.event, 'agentic_memory_operation_controller_execute');

  res = run(policyPath, ['status', '--owner=test_owner']);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.action === 'status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('agentic_memory_operation_controller.test.js: OK');
} catch (err) {
  console.error(`agentic_memory_operation_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

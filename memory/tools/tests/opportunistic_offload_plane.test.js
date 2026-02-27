#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'hardware', 'opportunistic_offload_plane.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunistic-offload-'));
  const policyPath = path.join(tmp, 'opportunistic_offload_policy.json');
  const mockSchedulePath = path.join(tmp, 'mock_schedule.js');
  const embodimentPath = path.join(tmp, 'state', 'hardware', 'embodiment', 'latest.json');
  const latestPath = path.join(tmp, 'state', 'hardware', 'opportunistic_offload', 'latest.json');
  const queuePath = path.join(tmp, 'state', 'hardware', 'opportunistic_offload', 'queue.jsonl');
  const receiptsPath = path.join(tmp, 'state', 'hardware', 'opportunistic_offload', 'receipts.jsonl');

  fs.writeFileSync(
    mockSchedulePath,
    "console.log(JSON.stringify({ok:true,lease_id:'lease-1',node:{node_id:'node-a'}}));\n",
    'utf8'
  );

  writeJson(embodimentPath, {
    profile_id: 'phone',
    surface_budget: { score: 0.2 }
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    local_execution_score_threshold: 0.45,
    local_max_complexity: 0.5,
    embodiment_snapshot_path: embodimentPath,
    schedule_command: [process.execPath, mockSchedulePath],
    latest_path: latestPath,
    queue_path: queuePath,
    receipts_path: receiptsPath
  });

  const env = { OPPORTUNISTIC_OFFLOAD_POLICY_PATH: policyPath };
  const offloadRes = run(['dispatch', '--job-id=job_a', '--complexity=0.9', '--required-ram-gb=4', '--required-cpu-threads=4', '--strict=1'], env);
  assert.strictEqual(offloadRes.status, 0, offloadRes.stderr || 'offload dispatch should pass');
  const offloadPayload = parseJson(offloadRes.stdout);
  assert.ok(offloadPayload && offloadPayload.ok === true, 'offload payload should be ok');
  assert.strictEqual(offloadPayload.effective_route, 'offload', 'expected offload route');
  assert.ok(offloadPayload.schedule && offloadPayload.schedule.ok === true, 'schedule should succeed');

  writeJson(embodimentPath, {
    profile_id: 'desktop',
    surface_budget: { score: 0.9 }
  });
  const localRes = run(['dispatch', '--job-id=job_b', '--complexity=0.2', '--strict=1'], env);
  assert.strictEqual(localRes.status, 0, localRes.stderr || 'local dispatch should pass');
  const localPayload = parseJson(localRes.stdout);
  assert.ok(localPayload && localPayload.ok === true, 'local payload should be ok');
  assert.strictEqual(localPayload.effective_route, 'local', 'expected local route');

  const statusRes = run(['status'], env);
  assert.strictEqual(statusRes.status, 0, statusRes.stderr || 'status should pass');
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Number(statusPayload.queue_count || 0) >= 2, 'queue should contain dispatch rows');

  console.log('opportunistic_offload_plane.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`opportunistic_offload_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run(script, args, env = {}) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  const text = String(proc.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break; } catch {}
    }
  }
  return { status: Number(proc.status || 0), payload, stderr: String(proc.stderr || '') };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-mesh-pack-'));

  const meshPolicy = path.join(tmp, 'mesh_policy.json');
  const devicePolicy = path.join(tmp, 'device_policy.json');
  const fedLearnPolicy = path.join(tmp, 'fed_learning_policy.json');
  const surfacePath = path.join(tmp, 'surface_budget.json');

  writeJson(surfacePath, { mode: 'balanced' });
  writeJson(meshPolicy, {
    enabled: true,
    shadow_only: true,
    require_attested_peers: true,
    replication_quorum: 2,
    min_trust_score: 0.5,
    paths: {
      state_path: path.join(tmp, 'mesh_state.json'),
      latest_path: path.join(tmp, 'mesh_latest.json'),
      receipts_path: path.join(tmp, 'mesh_receipts.jsonl'),
      replication_log_path: path.join(tmp, 'mesh_replication.jsonl'),
      partition_drills_path: path.join(tmp, 'mesh_drills.jsonl')
    }
  });

  writeJson(devicePolicy, {
    enabled: true,
    shadow_only: true,
    max_workers_per_mesh: 8,
    paths: {
      latest_path: path.join(tmp, 'device_latest.json'),
      receipts_path: path.join(tmp, 'device_receipts.jsonl'),
      state_path: path.join(tmp, 'device_state.json'),
      mesh_source_path: path.join(tmp, 'mesh_state.json'),
      surface_budget_path: surfacePath
    }
  });

  writeJson(fedLearnPolicy, {
    enabled: true,
    shadow_only: true,
    min_participants: 2,
    paths: {
      latest_path: path.join(tmp, 'fed_latest.json'),
      receipts_path: path.join(tmp, 'fed_receipts.jsonl'),
      state_path: path.join(tmp, 'fed_state.json')
    }
  });

  const meshScript = path.join(root, 'systems', 'ops', 'federated_sovereign_mesh_runtime.js');
  const deviceScript = path.join(root, 'systems', 'hardware', 'device_mesh_adaptive_runtime.js');
  const fedLearnScript = path.join(root, 'systems', 'ops', 'cross_instance_federated_learning.js');

  let out = run(meshScript, ['join', '--node-id=node-a', '--trust=0.9', '--capacity=200', '--attested=1', '--apply=1', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'mesh join a should succeed');
  assert.ok(out.payload && out.payload.ok === true, 'mesh join a payload ok');

  out = run(meshScript, ['join', '--node-id=node-b', '--trust=0.8', '--capacity=180', '--attested=1', '--apply=1', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'mesh join b should succeed');

  out = run(meshScript, ['elect', '--apply=1', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'mesh elect should succeed');
  assert.ok(String(out.payload.leader_node_id || '').length > 0, 'leader should be selected');

  out = run(meshScript, ['replicate', '--stream=task_queue', '--payload=hello', '--apply=1', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'mesh replicate should succeed');
  assert.strictEqual(out.payload.quorum_met, true, 'replication quorum should pass');

  out = run(meshScript, ['partition-drill', '--apply=1', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'partition drill should succeed');

  out = run(deviceScript, ['assign-roles', '--apply=1', `--policy=${devicePolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'device role assignment should succeed');

  out = run(fedLearnScript, ['ingest', '--node-id=node-a', '--lift=0.2', '--privacy=high', '--apply=1', `--policy=${fedLearnPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'fed learn ingest a should succeed');
  out = run(fedLearnScript, ['ingest', '--node-id=node-b', '--lift=0.35', '--privacy=high', '--apply=1', `--policy=${fedLearnPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'fed learn ingest b should succeed');

  out = run(fedLearnScript, ['aggregate', '--apply=1', `--policy=${fedLearnPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'fed learn aggregate should succeed');
  assert.strictEqual(out.payload.aggregation_ok, true, 'aggregation should be ok');

  out = run(meshScript, ['status', `--policy=${meshPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || 'mesh status should succeed');
  assert.ok(Number(out.payload.node_count || 0) >= 2, 'mesh should track two nodes');

  console.log('v4_mesh_runtime_pack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`v4_mesh_runtime_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

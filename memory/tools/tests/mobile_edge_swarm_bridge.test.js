#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'spawn', 'mobile_edge_swarm_bridge.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-swarm-'));
  const lineagePolicyPath = path.join(tmp, 'config', 'seed_spawn_lineage_policy.json');
  const policyPath = path.join(tmp, 'config', 'mobile_edge_swarm_bridge_policy.json');

  writeJson(lineagePolicyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spawn.lineage' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'lineage'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'lineage', 'seed_spawn_index.json'),
      contracts_dir: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'contracts'),
      latest_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'latest.json'),
      history_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'receipts.jsonl')
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spawn.mobile_edge' },
    require_provenance_attestation: true,
    lineage_policy_path: lineagePolicyPath,
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'swarm'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'swarm', 'index.json'),
      events_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'receipts.jsonl'),
      enrollment_state_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'state.json')
    }
  });

  let out = run([
    'enroll',
    '--owner=jay',
    '--device-id=phone_01',
    '--parent=jay',
    '--child=edge_phone_01',
    '--provenance-attested=1',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_edge_node_enrolled');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(Number(out.payload.enrolled_nodes || 0) >= 1, true);

  out = run(['quarantine', '--owner=jay', '--device-id=phone_01', '--reason=test_quarantine', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_edge_node_quarantined');

  out = run(['evict', '--owner=jay', '--device-id=phone_01', '--reason=test_evict', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mobile_edge_node_evicted');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mobile_edge_swarm_bridge.test.js: OK');
} catch (err) {
  console.error(`mobile_edge_swarm_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

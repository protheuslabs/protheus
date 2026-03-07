#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'spawn', 'rsi_swarm_spawn_bridge.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-spawn-bridge-'));
  const policyPath = path.join(tmp, 'config', 'rsi_swarm_spawn_bridge_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spawn.rsi_swarm_bridge' },
    seed_lineage_script: path.join(ROOT, 'systems', 'spawn', 'seed_spawn_lineage.js'),
    nursery_script: path.join(ROOT, 'systems', 'nursery', 'nursery_bootstrap.js'),
    spawn_broker_script: path.join(ROOT, 'systems', 'spawn', 'spawn_broker.js'),
    provenance_gate_script: path.join(ROOT, 'systems', 'security', 'supply_chain_provenance_gate.js'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'spawn', 'rsi_swarm_spawn_bridge'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'spawn', 'rsi_swarm_spawn_bridge', 'index.json'),
      events_path: path.join(tmp, 'state', 'spawn', 'rsi_swarm_spawn_bridge', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'spawn', 'rsi_swarm_spawn_bridge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'spawn', 'rsi_swarm_spawn_bridge', 'receipts.jsonl'),
      bridge_state_path: path.join(tmp, 'state', 'spawn', 'rsi_swarm_spawn_bridge', 'state.json')
    }
  });

  let out = run(['bridge', '--owner=jay', '--parent=seed_a', '--child=seed_b', '--mock=1', '--strict=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_swarm_spawn_bridge', 'bridge should emit receipt');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.bridge_state && Number(out.payload.bridge_state.runs || 0) >= 1, 'status should show bridge state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_swarm_spawn_bridge.test.js: OK');
} catch (err) {
  console.error(`rsi_swarm_spawn_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

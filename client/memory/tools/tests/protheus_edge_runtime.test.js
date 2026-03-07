#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'edge', 'protheus_edge_runtime.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-edge-runtime-'));
  const policyPath = path.join(tmp, 'config', 'protheus_edge_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'edge.runtime' },
    edge_runtime: {
      require_contract_lane_verified: true,
      allow_profiles: ['mobile_seed', 'offline_cache'],
      max_cache_snapshots: 32
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'protheus_edge'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'protheus_edge', 'index.json'),
      events_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'receipts.jsonl'),
      session_state_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'session_state.json'),
      cache_index_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'cache_index.json')
    }
  });

  let out = run(['configure', '--owner=jay', '--profile=mobile_seed', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run([
    'start',
    '--owner=jay',
    '--profile=mobile_seed',
    '--cache-mode=memfs_cached',
    '--remote-spine=https://edge.example',
    '--online=1',
    '--contract-lane-verified=1',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'edge_start');

  out = run(['sync', '--owner=jay', '--online=0', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(['edge_sync_remote', 'edge_sync_offline_fallback'].includes(String(out.payload.event || '')));

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.edge_session.active, true);
  assert.strictEqual(Number(out.payload.cache_snapshots) >= 1, true);

  out = run(['rollback', '--owner=jay', '--target-profile=offline_cache', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['stop', '--owner=jay', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_edge_runtime.test.js: OK');
} catch (err) {
  console.error(`protheus_edge_runtime.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

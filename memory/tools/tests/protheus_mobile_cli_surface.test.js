#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const PROTHEUS_TOP = path.join(ROOT, 'systems', 'ops', 'protheus_top.js');

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

function run(script, args, envExtra = {}) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envExtra
    }
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cli-surface-'));
  const edgePolicy = path.join(tmp, 'config', 'protheus_edge_policy.json');
  const lifecyclePolicy = path.join(tmp, 'config', 'mobile_lifecycle_resilience_policy.json');
  const swarmPolicy = path.join(tmp, 'config', 'mobile_edge_swarm_bridge_policy.json');
  const topPolicy = path.join(tmp, 'config', 'mobile_ops_top_policy.json');

  writeJson(edgePolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'edge.runtime' },
    edge_runtime: { require_contract_lane_verified: true, allow_profiles: ['mobile_seed'] },
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

  writeJson(lifecyclePolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'edge.lifecycle' },
    thresholds: {
      battery_soft_pct: 30,
      battery_hard_pct: 18,
      thermal_soft_c: 42,
      thermal_hard_c: 48,
      background_kill_soft: 2,
      background_kill_hard: 4,
      wake_lock_soft_min: 20,
      wake_lock_hard_min: 45,
      target_autonomy_hours: 72
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'lifecycle'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'lifecycle', 'index.json'),
      events_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'receipts.jsonl'),
      lifecycle_state_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'state.json')
    }
  });

  writeJson(swarmPolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spawn.mobile_edge' },
    require_provenance_attestation: false,
    paths: {
      memory_dir: path.join(tmp, 'memory', 'edge', 'swarm'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'edge', 'swarm', 'index.json'),
      events_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'receipts.jsonl'),
      enrollment_state_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'state.json')
    }
  });

  writeJson(topPolicy, {
    version: '1.0-test',
    enabled: true,
    paths: {
      edge_latest_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'latest.json'),
      edge_state_path: path.join(tmp, 'state', 'edge', 'protheus_edge', 'session_state.json'),
      lifecycle_latest_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'latest.json'),
      lifecycle_state_path: path.join(tmp, 'state', 'edge', 'mobile_lifecycle', 'state.json'),
      swarm_latest_path: path.join(tmp, 'state', 'spawn', 'mobile_edge_swarm_bridge', 'latest.json')
    }
  });

  let out = run(PROTHEUSCTL, [
    'edge',
    'start',
    '--owner=jay',
    '--profile=mobile_seed',
    '--cache-mode=memfs_cached',
    '--remote-spine=https://edge.example',
    '--contract-lane-verified=1',
    '--apply=1',
    `--policy=${edgePolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(PROTHEUSCTL, ['edge', 'status', '--owner=jay', `--policy=${edgePolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.edge_session.active, true);

  out = run(PROTHEUSCTL, ['edge', 'lifecycle', 'run', '--owner=jay', '--battery=75', '--thermal=36', '--apply=1', `--policy=${lifecyclePolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(PROTHEUSCTL, ['edge', 'swarm', 'status', '--owner=jay', `--policy=${swarmPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(PROTHEUS_TOP, ['--mobile'], { MOBILE_OPS_TOP_POLICY_PATH: topPolicy });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.type, 'protheus_mobile_top');

  out = run(PROTHEUS_TOP, ['--mobile', '--human=1'], { MOBILE_OPS_TOP_POLICY_PATH: topPolicy });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(String(out.stdout || '').includes('MOBILE TOP'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_mobile_cli_surface.test.js: OK');
} catch (err) {
  console.error(`protheus_mobile_cli_surface.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

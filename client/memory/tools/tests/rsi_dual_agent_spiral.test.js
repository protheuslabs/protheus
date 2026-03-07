#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'adaptive', 'rsi', 'dual_agent_spiral.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-dual-agent-'));
  const policyPath = path.join(tmp, 'config', 'rsi_dual_agent_spiral_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'adaptive.rsi.dual_agent_spiral' },
    system3_script: path.join(ROOT, 'adaptive', 'executive', 'system3_executive_layer.js'),
    rsi_script: path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js'),
    rsi_policy_path: path.join(ROOT, 'config', 'rsi_bootstrap_policy.json'),
    target_paths: ['client/systems/strategy/strategy_learner.ts', 'client/systems/autonomy/model_catalog_loop.ts'],
    paths: {
      memory_dir: path.join(tmp, 'memory', 'adaptive', 'rsi_dual_agent_spiral'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'rsi', 'dual_agent_spiral', 'index.json'),
      events_path: path.join(tmp, 'state', 'adaptive', 'rsi_dual_agent_spiral', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'adaptive', 'rsi_dual_agent_spiral', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'adaptive', 'rsi_dual_agent_spiral', 'receipts.jsonl'),
      spiral_state_path: path.join(tmp, 'state', 'adaptive', 'rsi_dual_agent_spiral', 'state.json')
    }
  });

  let out = run(['run', '--owner=jay', '--cycles=2', '--mock=1', '--apply=1', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_dual_agent_spiral_run', 'run should emit spiral receipt');

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.spiral_state && Number(out.payload.spiral_state.runs || 0) >= 1, 'status should return spiral state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_dual_agent_spiral.test.js: OK');
} catch (err) {
  console.error(`rsi_dual_agent_spiral.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

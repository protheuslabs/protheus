#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rsi_control_plane_cli_surface_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-cli-surface-'));
  const stateRoot = path.join(tmp, 'state', 'adaptive', 'rsi');
  const rsiPolicyPath = path.join(tmp, 'config', 'rsi_bootstrap_policy.json');
  const contractPolicyPath = path.join(tmp, 'config', 'rsi_control_plane_cli_surface_contract_policy.json');

  writeJson(rsiPolicyPath, {
    enabled: true,
    shadow_only: true,
    owner_default: 'jay',
    paths: {
      state_path: path.join(stateRoot, 'state.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      chain_path: path.join(stateRoot, 'chain.jsonl'),
      merkle_path: path.join(stateRoot, 'merkle.json'),
      approvals_path: path.join(stateRoot, 'approvals.json'),
      step_artifacts_dir: path.join(stateRoot, 'steps')
    }
  });

  writeJson(contractPolicyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.rsi_control_plane_cli_surface' },
    protheusctl_script: path.join(ROOT, 'systems', 'ops', 'protheusctl.js'),
    rsi_policy_path: rsiPolicyPath,
    rsi_history_path: path.join(stateRoot, 'receipts.jsonl'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'rsi_control_plane_cli_surface_contract'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'rsi_control_plane_cli_surface_contract', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'rsi_control_plane_cli_surface_contract', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'rsi_control_plane_cli_surface_contract', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'rsi_control_plane_cli_surface_contract', 'receipts.jsonl'),
      contract_state_path: path.join(tmp, 'state', 'ops', 'rsi_control_plane_cli_surface_contract', 'state.json')
    }
  });

  const out = run(['verify', '--owner=jay', '--strict=1', '--apply=1', `--policy=${contractPolicyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_control_plane_cli_surface_verify', 'verify should emit contract receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_control_plane_cli_surface_contract.test.js: OK');
} catch (err) {
  console.error(`rsi_control_plane_cli_surface_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

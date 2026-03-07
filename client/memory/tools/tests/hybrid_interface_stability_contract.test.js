#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'hybrid_interface_stability_contract.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-interface-contract-'));
  const policyPath = path.join(tmp, 'config', 'hybrid_interface_stability_contract_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'ops.hybrid_interface_stability_contract' },
    protheusctl_script: path.join(ROOT, 'systems', 'ops', 'protheusctl.js'),
    rsi_policy_path: path.join(ROOT, 'config', 'rsi_bootstrap_policy.json'),
    rust_cutover_script: path.join(ROOT, 'systems', 'ops', 'rust_control_plane_cutover.js'),
    profile_compat_script: path.join(ROOT, 'systems', 'ops', 'profile_compatibility_gate.js'),
    snapshot_path: path.join(tmp, 'state', 'ops', 'hybrid_interface_stability_contract', 'snapshot.json'),
    auto_rollback_on_drift: false,
    refresh_snapshot_on_apply: true,
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'hybrid_interface_stability_contract'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'hybrid_interface_stability_contract', 'index.json'),
      events_path: path.join(tmp, 'state', 'ops', 'hybrid_interface_stability_contract', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'hybrid_interface_stability_contract', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'hybrid_interface_stability_contract', 'receipts.jsonl'),
      hybrid_state_path: path.join(tmp, 'state', 'ops', 'hybrid_interface_stability_contract', 'state.json')
    }
  });

  const out = run(['verify', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'hybrid_interface_stability_contract_verify', 'verify should emit hybrid contract receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('hybrid_interface_stability_contract.test.js: OK');
} catch (err) {
  console.error(`hybrid_interface_stability_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'mcp_a2a_venom_contract_gate.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-a2a-venom-'));
  const policyPath = path.join(tmp, 'config', 'mcp_a2a_venom_contract_gate_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'security.mcp_a2a_venom_gate' },
    fail_closed: true,
    venom_script: 'client/systems/security/venom_containment_layer.js',
    routes: {
      mcp_discover: { script: 'client/skills/mcp/mcp_gateway.js', args: ['discover', '--query=memory', '--risk-tier=2'] },
      a2a_delegate: { script: 'client/systems/a2a/a2a_delegation_plane.js', args: ['execute', '--owner=system', '--task=delegate', '--risk-tier=2'] }
    },
    contract_lanes: [
      { id: 'RR-001', script: 'client/systems/ops/config_flag_conflict_check.js', check_cmd: 'check' }
    ],
    paths: {
      memory_dir: path.join(tmp, 'memory', 'security', 'mcp_a2a_venom_contract_gate'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'security', 'mcp_a2a_venom_contract_gate', 'index.json'),
      events_path: path.join(tmp, 'state', 'security', 'mcp_a2a_venom_contract_gate', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'security', 'mcp_a2a_venom_contract_gate', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'mcp_a2a_venom_contract_gate', 'receipts.jsonl')
    }
  });

  let out = run(['verify', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'mcp_a2a_venom_contract_gate_verify');
  assert.strictEqual(out.payload.routes_ok, true);

  out = run(['status', '--owner=jay', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mcp_a2a_venom_contract_gate.test.js: OK');
} catch (err) {
  console.error(`mcp_a2a_venom_contract_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

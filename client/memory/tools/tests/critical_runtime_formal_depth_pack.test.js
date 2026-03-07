#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'critical_runtime_formal_depth_pack.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-formal-depth-'));
  const policyPath = path.join(tmp, 'config', 'critical_runtime_formal_depth_pack_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'security.critical_runtime_formal_depth_pack' },
    critical_path_formal_script: path.join(ROOT, 'systems', 'security', 'critical_path_formal_verifier.js'),
    sovereignty_formal_script: path.join(ROOT, 'systems', 'security', 'formal_mind_sovereignty_verification.js'),
    self_mod_gate_script: path.join(ROOT, 'systems', 'security', 'rsi_git_patch_self_mod_gate.js'),
    integrity_chain_script: path.join(ROOT, 'adaptive', 'rsi', 'rsi_integrity_chain_guard.js'),
    provenance_gate_script: path.join(ROOT, 'systems', 'security', 'supply_chain_provenance_gate.js'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'security', 'critical_runtime_formal_depth_pack'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'security', 'critical_runtime_formal_depth_pack', 'index.json'),
      events_path: path.join(tmp, 'state', 'security', 'critical_runtime_formal_depth_pack', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'security', 'critical_runtime_formal_depth_pack', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'critical_runtime_formal_depth_pack', 'receipts.jsonl'),
      depth_pack_state_path: path.join(tmp, 'state', 'security', 'critical_runtime_formal_depth_pack', 'state.json')
    }
  });

  const out = run(['verify', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'critical_runtime_formal_depth_pack_verify', 'verify should emit formal depth receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('critical_runtime_formal_depth_pack.test.js: OK');
} catch (err) {
  console.error(`critical_runtime_formal_depth_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

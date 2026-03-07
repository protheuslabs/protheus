#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'client/systems/security/thorn_swarm_protocol.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thorn_swarm_protocol-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state');
  const checks = [
  {
    "id": "tier4_swarm_scaling",
    "description": "Swarm wave scaling tracks attack intensity"
  },
  {
    "id": "short_ttl_self_destruct",
    "description": "Sacrificial cells enforce short TTL self-destruct"
  },
  {
    "id": "trap_profile_execution",
    "description": "Trap profile pack executes within policy bounds"
  },
  {
    "id": "jigsaw_replay_markers",
    "description": "Jigsaw replay markers emitted for swarm waves"
  }
];

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    checks,
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl')
    }
  });

  let out = run(['swarm', '--policy=' + policyPath, '--strict=1', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lane run should pass baseline checks');
  assert.strictEqual(Number(out.payload.check_count || 0), checks.length, 'all checks should be evaluated');

  out = run(['swarm', '--policy=' + policyPath, '--strict=1', '--apply=1', '--fail-checks=tier4_swarm_scaling']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when required check fails');
  assert.ok(out.payload && out.payload.ok === false, 'payload should indicate failed run');
  assert.ok(Array.isArray(out.payload.failed_checks) && out.payload.failed_checks.includes('tier4_swarm_scaling'), 'failed check id should be listed');

  out = run(['status', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest artifact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('thorn_swarm_protocol.test.js: OK');
} catch (err) {
  console.error('thorn_swarm_protocol.test.js: FAIL: ' + err.message);
  process.exit(1);
}

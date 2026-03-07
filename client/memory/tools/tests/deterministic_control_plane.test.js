#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'distributed', 'deterministic_control_plane.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'det-control-plane-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'history.jsonl');

  writeJson(policyPath, {
    schema_id: 'deterministic_control_plane_policy',
    schema_version: '1.0',
    enabled: true,
    quorum_size: 2,
    local_trust_domain: 'alpha',
    leader_strategy: 'lexicographic_node_id',
    state_path: statePath,
    history_path: historyPath
  });

  const env = { DETERMINISTIC_CONTROL_PLANE_POLICY_PATH: policyPath };

  const run1 = run([
    'run',
    '--nodes-json=[{"node_id":"node-b","online":true,"attested":true,"partition_id":"main","trust_domain":"alpha"},{"node_id":"node-a","online":true,"attested":true,"partition_id":"main","trust_domain":"alpha"},{"node_id":"foreign-z","online":true,"attested":true,"partition_id":"main","trust_domain":"beta"}]',
    '--apply=1'
  ], env);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1.stdout);
  assert.strictEqual(out1.quorum_met, true);
  assert.strictEqual(out1.leader_node_id, 'node-a', 'leader should be deterministic lexicographic');
  assert.ok(Number(out1.foreign_node_count || 0) >= 1);

  const run2 = run([
    'run',
    '--nodes-json=[{"node_id":"node-a","online":false,"attested":true,"partition_id":"main","trust_domain":"alpha"},{"node_id":"node-b","online":true,"attested":true,"partition_id":"main","trust_domain":"alpha"},{"node_id":"node-c","online":true,"attested":true,"partition_id":"main","trust_domain":"alpha"}]',
    '--apply=1'
  ], env);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2.stdout);
  assert.strictEqual(out2.leader_node_id, 'node-b', 'leader should fail over deterministically');
  assert.ok(Array.isArray(out2.events) && out2.events.some((e) => e.type === 'leader_failover'));

  const run3 = run([
    'run',
    '--nodes-json=[{"node_id":"node-b","online":true,"attested":true,"partition_id":"p1","trust_domain":"alpha"},{"node_id":"node-c","online":true,"attested":true,"partition_id":"p2","trust_domain":"alpha"}]',
    '--apply=1'
  ], env);
  assert.strictEqual(run3.status, 0, run3.stderr || run3.stdout);
  const out3 = parseJson(run3.stdout);
  assert.strictEqual(out3.quorum_met, false, 'split partitions should lose quorum');
  assert.strictEqual(out3.leader_node_id, null);

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.quorum_met, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('deterministic_control_plane.test.js: OK');
} catch (err) {
  console.error(`deterministic_control_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

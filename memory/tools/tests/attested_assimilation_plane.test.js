#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function parseJson(out) {
  const lines = String(out || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function runNode(cwd, args, env = {}) {
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function sha256File(filePath) {
  const body = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(body).digest('hex');
}

function attest(secret, nodeId, constitutionHash) {
  return crypto.createHmac('sha256', secret).update(`${nodeId}|${constitutionHash}`, 'utf8').digest('hex');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'hardware', 'attested_assimilation_plane.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attested-assimilation-'));

  const constitutionPath = path.join(tmp, 'AGENT-CONSTITUTION.md');
  fs.writeFileSync(constitutionPath, '# Constitution\nRoot\n', 'utf8');

  const policyPath = path.join(tmp, 'hardware_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    constitution_path: constitutionPath,
    state_path: path.join(tmp, 'state', 'state.json'),
    audit_path: path.join(tmp, 'state', 'audit.jsonl'),
    required_attestation_secret_env: 'HARDWARE_ASSIMILATION_SECRET',
    idle_dormant_sec: 60,
    max_nodes: 16,
    compatibility: {
      required_capabilities: ['ram_gb', 'cpu_threads', 'arch'],
      min_ram_gb: 1,
      min_cpu_threads: 1,
      allowed_arches: ['x86_64'],
      required_node_profile_version: null
    },
    scheduler: {
      default_lease_sec: 30,
      max_lease_sec: 120,
      max_leases_per_node: 4,
      min_leases_per_node: 1,
      baseline_cpu_threads_per_lease: 2,
      baseline_ram_gb_per_lease: 2,
      work_steal_enabled: true
    }
  });

  const constitutionHash = sha256File(constitutionPath);
  const secret = 'test-secret';
  const nodeId = 'node_a';

  const badJoin = runNode(repoRoot, [
    scriptPath,
    'join',
    `--node-id=${nodeId}`,
    '--attestation=bad',
    `--constitution-hash=${constitutionHash}`,
    '--capabilities-json={"ram_gb":16,"cpu_threads":8}',
    `--policy=${policyPath}`
  ], {
    HARDWARE_ASSIMILATION_SECRET: secret
  });
  assert.strictEqual(badJoin.status, 1, 'bad attestation should fail join');

  const goodJoin = runNode(repoRoot, [
    scriptPath,
    'join',
    `--node-id=${nodeId}`,
    `--attestation=${attest(secret, nodeId, constitutionHash)}`,
    `--constitution-hash=${constitutionHash}`,
    '--capabilities-json={"ram_gb":16,"cpu_threads":8,"arch":"x86_64"}',
    `--policy=${policyPath}`
  ], {
    HARDWARE_ASSIMILATION_SECRET: secret
  });
  assert.strictEqual(goodJoin.status, 0, goodJoin.stderr || 'good attestation should join');

  const incompatibleJoin = runNode(repoRoot, [
    scriptPath,
    'join',
    '--node-id=node_incompatible',
    `--attestation=${attest(secret, 'node_incompatible', constitutionHash)}`,
    `--constitution-hash=${constitutionHash}`,
    '--capabilities-json={"ram_gb":8,"cpu_threads":4,"arch":"arm64"}',
    `--policy=${policyPath}`
  ], {
    HARDWARE_ASSIMILATION_SECRET: secret
  });
  assert.strictEqual(incompatibleJoin.status, 1, 'incompatible arch should fail join');
  const incompatiblePayload = parseJson(incompatibleJoin.stdout);
  assert.strictEqual(incompatiblePayload.error, 'capability_incompatible');

  const nodeB = 'node_b';
  const joinB = runNode(repoRoot, [
    scriptPath,
    'join',
    `--node-id=${nodeB}`,
    `--attestation=${attest(secret, nodeB, constitutionHash)}`,
    `--constitution-hash=${constitutionHash}`,
    '--capabilities-json={"ram_gb":4,"cpu_threads":2,"arch":"x86_64"}',
    `--policy=${policyPath}`
  ], {
    HARDWARE_ASSIMILATION_SECRET: secret
  });
  assert.strictEqual(joinB.status, 0, joinB.stderr || 'second node join should pass');

  const hb = runNode(repoRoot, [scriptPath, 'heartbeat', `--node-id=${nodeId}`, `--policy=${policyPath}`]);
  assert.strictEqual(hb.status, 0, hb.stderr || 'heartbeat should pass');

  const schedule = runNode(repoRoot, [
    scriptPath,
    'schedule',
    '--work-id=work_1',
    '--required-ram-gb=8',
    '--required-cpu-threads=4',
    '--lease-sec=30',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(schedule.status, 0, schedule.stderr || 'schedule should pass');
  const schedulePayload = parseJson(schedule.stdout);
  assert.ok(schedulePayload.lease && schedulePayload.lease.lease_id, 'schedule should emit lease');
  assert.strictEqual(schedulePayload.lease.node_id, nodeId, 'high requirement should route to high-capacity node');

  const complete = runNode(repoRoot, [
    scriptPath,
    'complete',
    `--lease-id=${schedulePayload.lease.lease_id}`,
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(complete.status, 0, complete.stderr || 'complete should pass');

  // Partition-style drill: stale node_b should auto-transition to dormant.
  const statePath = path.join(tmp, 'state', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.nodes[nodeB].status = 'active';
  state.nodes[nodeB].last_seen_at = new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  const statusAfterStale = runNode(repoRoot, [scriptPath, 'status', `--policy=${policyPath}`]);
  assert.strictEqual(statusAfterStale.status, 0, statusAfterStale.stderr || 'status should pass after stale update');
  const stalePayload = parseJson(statusAfterStale.stdout);
  assert.strictEqual(stalePayload.nodes[nodeB].status, 'dormant', 'stale node should become dormant');

  // Elastic lease cap for node_a: with cpu=8/ram=16 and baseline per lease cpu=2/ram=2 => cap=4.
  const leaseIds = [];
  for (let i = 0; i < 4; i += 1) {
    const leaseRun = runNode(repoRoot, [
      scriptPath,
      'schedule',
      `--work-id=burst_${i}`,
      '--required-ram-gb=1',
      '--required-cpu-threads=1',
      '--lease-sec=60',
      `--policy=${policyPath}`
    ]);
    assert.strictEqual(leaseRun.status, 0, leaseRun.stderr || `elastic schedule ${i} should pass`);
    const payload = parseJson(leaseRun.stdout);
    leaseIds.push(payload.lease.lease_id);
    assert.strictEqual(payload.lease.node_id, nodeId, 'active capacity should route to node_a while node_b dormant');
  }
  const overflow = runNode(repoRoot, [
    scriptPath,
    'schedule',
    '--work-id=burst_overflow',
    '--required-ram-gb=1',
    '--required-cpu-threads=1',
    '--lease-sec=60',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(overflow.status, 1, 'fifth lease should fail when elastic cap reached');
  const overflowPayload = parseJson(overflow.stdout);
  assert.strictEqual(overflowPayload.error, 'no_eligible_node');

  // Work-steal reissue: expire one lease and reschedule same work-id.
  const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const leaseToExpire = state2.leases[leaseIds[0]];
  leaseToExpire.status = 'active';
  leaseToExpire.expires_at = new Date(Date.now() - 60 * 1000).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state2, null, 2), 'utf8');
  const sweep = runNode(repoRoot, [scriptPath, 'status', `--policy=${policyPath}`]);
  assert.strictEqual(sweep.status, 0, sweep.stderr || 'status should sweep expired leases');
  const reissue = runNode(repoRoot, [
    scriptPath,
    'schedule',
    '--work-id=burst_0',
    '--required-ram-gb=1',
    '--required-cpu-threads=1',
    '--lease-sec=60',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(reissue.status, 0, reissue.stderr || 'reissue should pass for reassignable work');
  const reissuePayload = parseJson(reissue.stdout);
  assert.strictEqual(
    String(reissuePayload.lease.reissued_from_lease_id || ''),
    String(leaseIds[0]),
    'work-steal schedule should link to expired reassignable lease'
  );

  const status = runNode(repoRoot, [scriptPath, 'status', `--policy=${policyPath}`]);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload.nodes[nodeId], 'status should include joined node');

  console.log('attested_assimilation_plane.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`attested_assimilation_plane.test.js: FAIL: ${err && err.stack ? err.stack : err.message}`);
  process.exit(1);
}

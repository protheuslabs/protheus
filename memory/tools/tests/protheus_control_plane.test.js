#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'protheus_control_plane.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-plane-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateRoot = path.join(tmp, 'state');
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      state_root: stateRoot,
      daemon_path: path.join(stateRoot, 'daemon.json'),
      commands_path: path.join(stateRoot, 'commands.jsonl'),
      jobs_path: path.join(stateRoot, 'jobs.json'),
      incidents_path: path.join(stateRoot, 'incidents.jsonl'),
      release_path: path.join(stateRoot, 'release.json'),
      registry_path: path.join(stateRoot, 'registry.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      auth_sources_path: path.join(stateRoot, 'auth_sources.json'),
      integrity_queue_path: path.join(stateRoot, 'integrity_queue.json'),
      event_ledger_path: path.join(stateRoot, 'events.jsonl'),
      routing_preflight_path: path.join(stateRoot, 'preflight.json'),
      routing_doctor_path: path.join(stateRoot, 'doctor.json'),
      routing_health_path: path.join(stateRoot, 'health.json'),
      warm_snapshot_path: path.join(stateRoot, 'warm_snapshot.json'),
      benchmark_state_path: path.join(stateRoot, 'benchmark.json')
    }
  });

  writeJson(path.join(stateRoot, 'auth_sources.json'), {
    sources: [{ id: 'bird', expires_at: new Date(Date.now() + 3600 * 1000).toISOString() }]
  });
  writeJson(path.join(stateRoot, 'integrity_queue.json'), {
    mismatches: [{ class: 'deterministic_hash_drift', file: 'x' }]
  });
  writeJson(path.join(stateRoot, 'benchmark.json'), {
    cold_start_ms: 200,
    idle_rss_mb: 90,
    install_artifact_mb: 55
  });

  let res = run(['start', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  res = run(['job-submit', `--policy=${policyPath}`, '--kind=test']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = run(['job-runner', `--policy=${policyPath}`, '--max=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.processed >= 1, 'should process jobs');

  res = run(['auth-guard', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  res = run(['reseal-auto', `--policy=${policyPath}`, '--apply=1', '--approval-note=ok']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = run(['cli-contract', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'cli contract should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_control_plane.test.js: OK');
} catch (err) {
  console.error(`protheus_control_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'enterprise_scm_cd_mirror_plane.js');

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

function run(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

function mirrorState() {
  return {
    branch_policies: {
      main: {
        protected: true,
        required_checks: ['build', 'formal', 'test']
      }
    },
    gates: {
      build: { status: 'pass', receipt_id: 'g-build-1' },
      test: { status: 'pass', receipt_id: 'g-test-1' },
      formal: { status: 'pass', receipt_id: 'g-formal-1' },
      chaos: { status: 'pass', receipt_id: 'g-chaos-1' }
    }
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-cd-mirror-'));
  const githubPath = path.join(tmp, 'state', 'ops', 'scm_mirror', 'github_latest.json');
  const azurePath = path.join(tmp, 'state', 'ops', 'scm_mirror', 'azure_latest.json');
  const statePath = path.join(tmp, 'state', 'ops', 'enterprise_scm_cd_mirror_plane', 'state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'enterprise_scm_cd_mirror_plane', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'enterprise_scm_cd_mirror_plane', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'enterprise_scm_cd_mirror_plane_policy.json');

  writeJson(githubPath, mirrorState());
  writeJson(azurePath, mirrorState());
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    auto_disable_on_divergence: true,
    required_branches: ['main'],
    required_gates: ['build', 'test', 'formal', 'chaos'],
    sources: {
      github_state_path: githubPath,
      azure_state_path: azurePath
    },
    paths: {
      state_path: statePath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--strict=1', `--policy=${policyPath}`], {
    SCM_CD_MIRROR_ROOT: tmp,
    SCM_CD_MIRROR_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'parity should pass when mirror states match');

  const drifted = mirrorState();
  drifted.gates.chaos.status = 'fail';
  writeJson(azurePath, drifted);

  out = run(['run', '--strict=1', `--policy=${policyPath}`], {
    SCM_CD_MIRROR_ROOT: tmp,
    SCM_CD_MIRROR_POLICY_PATH: policyPath
  });
  assert.notStrictEqual(out.status, 0, 'strict run should fail on gate drift');
  assert.strictEqual(out.payload.ok, false, 'drift should fail parity');
  assert.strictEqual(out.payload.mirror_enabled, false, 'mirror should auto-disable on divergence');
  assert.ok(Number(out.payload.divergence_count || 0) > 0, 'divergence count should be positive');

  out = run(['reseed', '--approve=1', `--policy=${policyPath}`], {
    SCM_CD_MIRROR_ROOT: tmp,
    SCM_CD_MIRROR_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'reseed should succeed with approval');

  out = run(['status', `--policy=${policyPath}`], {
    SCM_CD_MIRROR_ROOT: tmp,
    SCM_CD_MIRROR_POLICY_PATH: policyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'status should succeed');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('enterprise_scm_cd_mirror_plane.test.js: OK');
} catch (err) {
  console.error(`enterprise_scm_cd_mirror_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

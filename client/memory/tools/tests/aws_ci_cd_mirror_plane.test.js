#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'aws_ci_cd_mirror_plane.js');

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
      chaos: { status: 'pass', receipt_id: 'g-chaos-1' },
      fis: { status: 'pass', receipt_id: 'g-fis-1' }
    }
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cicd-mirror-'));
  const githubPath = path.join(tmp, 'state', 'ops', 'aws_ci_cd_mirror', 'github_latest.json');
  const awsPath = path.join(tmp, 'state', 'ops', 'aws_ci_cd_mirror', 'aws_latest.json');
  const statePath = path.join(tmp, 'state', 'ops', 'aws_ci_cd_mirror_plane', 'state.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'aws_ci_cd_mirror_plane', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'aws_ci_cd_mirror_plane', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'aws_ci_cd_mirror_plane_policy.json');

  writeJson(githubPath, mirrorState());
  writeJson(awsPath, mirrorState());
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    auto_disable_on_divergence: true,
    required_branches: ['main'],
    required_gates: ['build', 'test', 'formal', 'chaos', 'fis'],
    sources: {
      github_state_path: githubPath,
      aws_state_path: awsPath
    },
    paths: {
      state_path: statePath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['run', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'mirror should pass when all gates align');

  const drifted = mirrorState();
  drifted.gates.fis.status = 'fail';
  writeJson(awsPath, drifted);

  out = run(['run', '--strict=1', `--policy=${policyPath}`]);
  assert.notStrictEqual(out.status, 0, 'strict run should fail on drift');
  assert.strictEqual(out.payload.ok, false, 'drift should fail parity');
  assert.strictEqual(out.payload.mirror_enabled, false, 'mirror should auto-disable on drift');
  assert.ok(Array.isArray(out.payload.divergences) && out.payload.divergences.some((row) => row.kind === 'gate_parity_fail' && row.gate === 'fis'), 'expected FIS divergence');

  writeJson(awsPath, mirrorState());
  out = run(['reseed', '--approve=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.state, 'status should return state');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('aws_ci_cd_mirror_plane.test.js: OK');
} catch (err) {
  console.error(`aws_ci_cd_mirror_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust50_conf001_execution_cutover.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function fail(msg) {
  console.error(`❌ rust50_conf001_execution_cutover.test.js: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust50-conf001-'));
  const policyPath = path.join(tmp, 'policy.json');

  const latestPath = path.join(tmp, 'state', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'history.jsonl');
  const artifactsDir = path.join(tmp, 'state', 'artifacts');

  const testRefsDir = path.join(tmp, 'refs');
  fs.mkdirSync(testRefsDir, { recursive: true });
  const refA = path.join(testRefsDir, 'a.txt');
  const refB = path.join(testRefsDir, 'b.txt');
  fs.writeFileSync(refA, 'a\n', 'utf8');
  fs.writeFileSync(refB, 'b\n', 'utf8');

  const policy = {
    version: '1.0',
    enabled: true,
    strict_default: true,
    lane_id: 'V6-RUST50-CONF-001',
    accepted_preamble: 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    required_refs: [refA, refB],
    checks: {
      wasm_build_cmd: ['node', '-e', 'process.exit(0)'],
      parity_test_cmd: ['node', '-e', 'process.exit(0)'],
      sovereignty_test_cmd: ['node', '-e', 'process.exit(0)']
    },
    outputs: {
      latest_path: latestPath,
      history_path: historyPath,
      artifacts_dir: artifactsDir
    }
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  const runRes = run([
    'run',
    `--policy=${policyPath}`,
    '--strict=1',
    '--apply=1',
    '--enforcer-active=1',
    '--preamble-text=ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    '--approval-recorded=1'
  ]);
  assert(runRes.status === 0, `run should pass: ${String(runRes.stderr || runRes.stdout).slice(0, 220)}`);

  const payload = parseJson(runRes.stdout);
  assert(payload && payload.ok === true, 'payload missing or not ok');
  assert(payload.checks && payload.checks.enforcer_preamble_ack === true, 'preamble check should pass');
  assert(payload.checks && payload.checks.approval_recorded === true, 'approval check should pass');
  assert(payload.checks && payload.checks.required_refs_ok === true, 'required refs check should pass');
  assert(payload.commands && payload.commands.wasm_build && payload.commands.wasm_build.ok === true, 'wasm command should pass');
  assert(fs.existsSync(latestPath), 'latest receipt should be written');
  assert(fs.existsSync(historyPath), 'history receipt should be written');

  const statusRes = run(['status', `--policy=${policyPath}`]);
  assert(statusRes.status === 0, `status failed: ${String(statusRes.stderr || statusRes.stdout).slice(0, 220)}`);
  const statusPayload = parseJson(statusRes.stdout);
  assert(statusPayload && statusPayload.ok === true, 'status payload should be ok');

  console.log('rust50_conf001_execution_cutover.test.js: OK');
}

main();

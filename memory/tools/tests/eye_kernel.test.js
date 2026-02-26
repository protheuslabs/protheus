#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runCmd(nodePath, scriptPath, argv, opts = {}) {
  return spawnSync(nodePath, [scriptPath].concat(argv || []), {
    encoding: 'utf8',
    ...opts
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'eye', 'eye_kernel.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-kernel-test-'));
  const policyPath = path.join(tmp, 'config', 'eye_kernel_policy.json');
  const statePath = path.join(tmp, 'state', 'eye', 'control_plane_state.json');
  const auditPath = path.join(tmp, 'state', 'eye', 'audit', 'command_bus.jsonl');
  const latestPath = path.join(tmp, 'state', 'eye', 'latest.json');
  const day = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0',
    default_decision: 'deny',
    clearance_levels: ['L0', 'L1', 'L2', 'L3'],
    risk: {
      escalate: ['medium'],
      deny: ['high', 'critical']
    },
    budgets: {
      global_daily_tokens: 120
    },
    lanes: {
      organ: {
        enabled: true,
        min_clearance: 'L1',
        daily_tokens: 100,
        actions: ['route', 'execute'],
        targets: ['workflow', 'autonomy']
      }
    }
  });

  const runRoute = (args) => runCmd(process.execPath, scriptPath, ['route'].concat(args), {
    cwd: root,
    env: {
      ...process.env,
      TZ: 'UTC'
    }
  });

  let r = runRoute([
    '--lane=organ',
    '--target=workflow',
    '--action=route',
    '--risk=low',
    '--clearance=L1',
    '--estimated-tokens=40',
    '--apply=1',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`
  ]);
  assert.strictEqual(r.status, 0, `allow route should succeed: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.ok(out && out.decision === 'allow', 'low risk + valid clearance should allow');

  r = runRoute([
    '--lane=organ',
    '--target=workflow',
    '--action=route',
    '--risk=medium',
    '--clearance=L2',
    '--estimated-tokens=5',
    '--apply=1',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`
  ]);
  assert.strictEqual(r.status, 0, `medium risk should escalate with success exit: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.decision === 'escalate', 'medium risk should escalate');

  r = runRoute([
    '--lane=organ',
    '--target=workflow',
    '--action=route',
    '--risk=high',
    '--clearance=L2',
    '--estimated-tokens=5',
    '--apply=1',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`
  ]);
  assert.strictEqual(r.status, 1, 'high risk should deny');
  out = parsePayload(r.stdout);
  assert.ok(out && out.decision === 'deny', 'high risk should deny');
  assert.ok(Array.isArray(out.reasons) && out.reasons.includes('risk_denied'), 'deny reason should include risk_denied');

  r = runRoute([
    '--lane=organ',
    '--target=workflow',
    '--action=execute',
    '--risk=low',
    '--clearance=L0',
    '--estimated-tokens=5',
    '--apply=1',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`
  ]);
  assert.strictEqual(r.status, 1, 'clearance below min should deny');
  out = parsePayload(r.stdout);
  assert.ok(Array.isArray(out.reasons) && out.reasons.includes('clearance_below_minimum'), 'deny reason should include clearance check');

  r = runRoute([
    '--lane=organ',
    '--target=autonomy',
    '--action=execute',
    '--risk=low',
    '--clearance=L2',
    '--estimated-tokens=70',
    '--apply=1',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`
  ]);
  assert.strictEqual(r.status, 1, 'budget overflow should deny');
  out = parsePayload(r.stdout);
  assert.ok(Array.isArray(out.reasons) && out.reasons.includes('lane_daily_budget_exceeded'), 'deny reason should include lane budget overflow');

  const statusRes = runCmd(process.execPath, scriptPath, [
    'status',
    `--date=${day}`,
    `--policy=${policyPath}`,
    `--state=${statePath}`
  ], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(statusRes.status, 0, `status command should pass: ${statusRes.stderr}`);
  const statusOut = parsePayload(statusRes.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(Number(statusOut.day_state.global_tokens_used || 0), 40, 'only the allow route should consume tokens');
  assert.strictEqual(Number(statusOut.day_state.lanes.organ.allow || 0), 1, 'one allow decision expected');
  assert.strictEqual(Number(statusOut.day_state.lanes.organ.escalate || 0), 1, 'one escalate decision expected');
  assert.strictEqual(Number(statusOut.day_state.lanes.organ.deny || 0), 3, 'three deny decisions expected');
  assert.ok(fs.existsSync(auditPath), 'audit trail should be written');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('eye_kernel.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`eye_kernel.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'rust50_sprint_contract.js');

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

function run(args, envExtra = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envExtra
    }
  });
  return {
    status: Number(out.status || 0),
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout)
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rust50-sprint-contract-'));
  const policyPath = path.join(tmp, 'config', 'rust50_sprint_contract_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'rust50_sprint_contract', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'rust50_sprint_contract', 'history.jsonl');
  const auditsDir = path.join(tmp, 'state', 'ops', 'rust50_sprint_contract', 'audits');
  const planPath = path.join(tmp, 'plan.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_default: true,
    sprint_id: 'V6-RUST50-CONF-002',
    accepted_preamble: 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      audit_dir: auditsDir
    }
  });

  writeJson(planPath, {
    sprint_id: 'V6-RUST50-CONF-002',
    batch_mode: true,
    tasks: [
      { id: 'task_01', title: 'enforcer preflight', status: 'completed' },
      { id: 'task_02', title: 'execute batch', status: 'completed' },
      { id: 'task_03', title: 'audit bundle', status: 'in_progress' }
    ]
  });

  let out = run([
    'run',
    '--policy', policyPath,
    '--sprint-id', 'V6-RUST50-CONF-002',
    '--batch-id', 'batch-a',
    '--plan-file', planPath,
    '--requested-status', 'in_progress',
    '--enforcer-active', '0',
    '--preamble-text', 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.'
  ]);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail closed without enforcer-active');
  assert.ok(out.payload && out.payload.ok === false, 'payload should fail');
  assert.ok(Array.isArray(out.payload.violations) && out.payload.violations.includes('enforcer_preamble_ack'), 'missing enforcer ack should be reported');

  out = run([
    'run',
    '--policy', policyPath,
    '--sprint-id', 'V6-RUST50-CONF-002',
    '--batch-id', 'batch-a',
    '--plan-file', planPath,
    '--requested-status', 'in_progress',
    '--enforcer-active', '1',
    '--preamble-text', 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || 'in_progress contract should pass');
  assert.ok(out.payload && out.payload.ok === true, 'payload should pass');
  assert.strictEqual(out.payload.effective_status, 'IN_PROGRESS');
  assert.ok(out.payload.audit_path, 'audit path should be returned');
  assert.ok(fs.existsSync(path.join(ROOT, out.payload.audit_path)), 'audit artifact should exist');

  writeJson(planPath, {
    sprint_id: 'V6-RUST50-CONF-002',
    batch_mode: true,
    tasks: [
      { id: 'task_01', title: 'enforcer preflight', status: 'completed' },
      { id: 'task_02', title: 'execute batch', status: 'skipped' },
      { id: 'task_03', title: 'audit bundle', status: 'in_progress' }
    ]
  });

  out = run([
    'run',
    '--policy', policyPath,
    '--sprint-id', 'V6-RUST50-CONF-002',
    '--batch-id', 'batch-b',
    '--plan-file', planPath,
    '--requested-status', 'in_progress',
    '--enforcer-active', '1',
    '--preamble-text', 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.'
  ]);
  assert.notStrictEqual(out.status, 0, 'skip should fail closed');
  assert.ok(out.payload && out.payload.ok === false, 'skip payload should fail');
  assert.ok(Array.isArray(out.payload.violations) && out.payload.violations.includes('no_skip'), 'no_skip violation expected');

  writeJson(planPath, {
    sprint_id: 'V6-RUST50-CONF-002',
    batch_mode: true,
    tasks: [
      { id: 'task_01', title: 'enforcer preflight', status: 'completed' },
      { id: 'task_02', title: 'execute batch', status: 'completed' },
      { id: 'task_03', title: 'audit bundle', status: 'completed' }
    ]
  });

  out = run([
    'run',
    '--policy', policyPath,
    '--sprint-id', 'V6-RUST50-CONF-002',
    '--batch-id', 'batch-c',
    '--plan-file', planPath,
    '--requested-status', 'done',
    '--enforcer-active', '1',
    '--preamble-text', 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    '--proof-refs', 'diff://abc,build://wasm,test://regression',
    '--approval-recorded', '0'
  ]);
  assert.notStrictEqual(out.status, 0, 'done without approval should fail');
  assert.ok(out.payload && out.payload.ok === false, 'done without approval should fail payload');
  assert.ok(Array.isArray(out.payload.violations) && out.payload.violations.includes('no_premature_done'), 'no_premature_done violation expected');

  out = run([
    'run',
    '--policy', policyPath,
    '--sprint-id', 'V6-RUST50-CONF-002',
    '--batch-id', 'batch-d',
    '--plan-file', planPath,
    '--requested-status', 'done',
    '--enforcer-active', '1',
    '--preamble-text', 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
    '--proof-refs', 'diff://abc,build://wasm,test://regression',
    '--approval-recorded', '1'
  ]);
  assert.strictEqual(out.status, 0, out.stderr || 'done with approval should pass');
  assert.ok(out.payload && out.payload.ok === true, 'done with approval should pass payload');
  assert.strictEqual(out.payload.effective_status, 'DONE_READY_FOR_HUMAN_AUDIT');

  const statusOut = run(['status', '--policy', policyPath]);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || 'status should pass');
  assert.ok(statusOut.payload && statusOut.payload.ok === true, 'status payload ok');
  assert.ok(statusOut.payload.latest && statusOut.payload.latest.audit_id, 'status should expose latest receipt');

  console.log('rust50_sprint_contract.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`rust50_sprint_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

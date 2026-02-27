#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_MODULE = path.join(ROOT, 'systems', 'primitives', 'primitive_runtime.js');
const REPLAY_SCRIPT = path.join(ROOT, 'systems', 'primitives', 'replay_verify.js');

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

function runNode(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'primitive-runtime-'));
  const policyPath = path.join(tmp, 'config', 'primitive_policy_vm.json');
  const logDir = path.join(tmp, 'state', 'runtime', 'canonical_events');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    schema_id: 'primitive_policy_vm',
    schema_version: '1.0',
    mode: 'advisory',
    deny_effects: [],
    shadow_only_effects: [],
    allow_opcode_overrides: [],
    block_opcode_overrides: [],
    emit_audit: true,
    audit_path: 'state/runtime/policy_vm/decisions.jsonl'
  }, null, 2));

  const priorPolicyPath = process.env.PRIMITIVE_POLICY_VM_PATH;
  const priorLogDir = process.env.CANONICAL_EVENT_LOG_DIR;
  process.env.PRIMITIVE_POLICY_VM_PATH = policyPath;
  process.env.CANONICAL_EVENT_LOG_DIR = logDir;

  delete require.cache[require.resolve(RUNTIME_MODULE)];
  const runtime = require(RUNTIME_MODULE);
  assert.ok(runtime && typeof runtime.executeCommandPrimitiveSync === 'function', 'runtime export missing');

  const result = runtime.executeCommandPrimitiveSync({
    command: 'node systems/autonomy/strategy_execute_guard.js run 2026-02-27',
    step: { id: 'step_a', type: 'command', timeout_ms: 1000 },
    context: { workflow_id: 'wf_a', run_id: 'run_a', objective_id: 'obj_a' },
    timeout_ms: 1000,
    runner: () => ({
      ok: true,
      shell_ok: true,
      exit_code: 0,
      signal: null,
      timed_out: false,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 3,
      stdout: 'ok',
      stderr: '',
      error: null
    })
  });

  assert.strictEqual(result.blocked, false, 'execution should not be blocked');
  assert.ok(result.primitive && result.primitive.opcode, 'primitive opcode missing');
  assert.ok(Array.isArray(result.event_ids) && result.event_ids.length === 2, 'expected start + finish events');

  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logDir, `${day}.jsonl`);
  assert.ok(fs.existsSync(logPath), 'canonical log should exist');
  const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(rows.length >= 2, 'canonical log should have at least two rows');

  const replay = runNode([REPLAY_SCRIPT, 'run', `--path=${logDir}`, '--strict=1'], {
    PRIMITIVE_POLICY_VM_PATH: policyPath,
    CANONICAL_EVENT_LOG_DIR: logDir,
    PRIMITIVE_REPLAY_REPORT_DIR: path.join(tmp, 'state', 'runtime', 'canonical_events', 'replay_reports')
  });
  assert.strictEqual(replay.status, 0, replay.stderr || 'replay verify should pass');
  const payload = parseJson(replay.stdout);
  assert.ok(payload && payload.ok === true, 'replay payload should pass');

  if (priorPolicyPath == null) delete process.env.PRIMITIVE_POLICY_VM_PATH;
  else process.env.PRIMITIVE_POLICY_VM_PATH = priorPolicyPath;
  if (priorLogDir == null) delete process.env.CANONICAL_EVENT_LOG_DIR;
  else process.env.CANONICAL_EVENT_LOG_DIR = priorLogDir;

  console.log('primitive_runtime.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`primitive_runtime.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

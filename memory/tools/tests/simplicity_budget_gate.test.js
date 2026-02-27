#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, root, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'ops', 'simplicity_budget_gate.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-gate-'));

  // Minimal synthetic runtime surface.
  write(path.join(tmp, 'systems', 'alpha', 'core.ts'), 'export const a = 1;\n');
  write(path.join(tmp, 'systems', 'alpha', 'notes.md'), '# alpha\n');
  write(path.join(tmp, 'systems', 'actuation', 'universal_execution_primitive.ts'), 'export {};\n');
  write(path.join(tmp, 'systems', 'actuation', 'custom_lane.ts'), 'export {};\n');

  writeJson(path.join(tmp, 'config', 'primitive_catalog.json'), {
    schema_id: 'primitive_catalog',
    schema_version: '1.0',
    default_command_opcode: 'SHELL_EXECUTE',
    command_rules: [
      { opcode: 'SHELL_EXECUTE' },
      { opcode: 'HTTP_REQUEST' }
    ],
    adapter_opcode_map: {
      shell: 'SHELL_EXECUTE'
    }
  });

  const policyPath = path.join(tmp, 'config', 'simplicity_budget_policy.json');
  const baselinePath = path.join(tmp, 'config', 'simplicity_baseline.json');
  const offsetsPath = path.join(tmp, 'state', 'ops', 'complexity_offsets.jsonl');
  const latestPath = path.join(tmp, 'state', 'ops', 'simplicity_budget', 'latest.json');

  writeJson(policyPath, {
    schema_id: 'simplicity_budget_policy',
    schema_version: '1.0',
    enabled: true,
    max_system_files: 50,
    max_system_loc: 5000,
    max_files_per_organ: 20,
    max_primitive_opcodes: 8,
    max_bespoke_actuation_modules: 3,
    require_offset_receipt_for_new_organs: true,
    systems_root: 'systems',
    baseline_path: 'config/simplicity_baseline.json',
    offset_receipts_path: 'state/ops/complexity_offsets.jsonl',
    latest_path: 'state/ops/simplicity_budget/latest.json'
  });

  writeJson(baselinePath, {
    schema_id: 'simplicity_baseline',
    schema_version: '1.0',
    organs: ['alpha', 'actuation'],
    max_bespoke_actuation_modules: 3
  });
  write(offsetsPath, '');

  const env = {
    ...process.env,
    SIMPLICITY_BUDGET_ROOT: tmp,
    SIMPLICITY_BUDGET_POLICY_PATH: policyPath
  };

  const passRun = run(script, repoRoot, ['run', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(passRun.status, 0, passRun.stderr || 'run should pass in strict mode');
  assert.ok(passRun.payload && passRun.payload.ok === true, 'expected ok payload');
  assert.ok(fs.existsSync(latestPath), 'latest result should be written');

  const failPolicyPath = path.join(tmp, 'config', 'simplicity_budget_policy.fail.json');
  writeJson(failPolicyPath, {
    ...JSON.parse(fs.readFileSync(policyPath, 'utf8')),
    max_primitive_opcodes: 1
  });
  const failRun = run(script, repoRoot, ['run', '--strict=1', `--policy=${failPolicyPath}`], {
    ...env,
    SIMPLICITY_BUDGET_POLICY_PATH: failPolicyPath
  });
  assert.notStrictEqual(failRun.status, 0, 'strict run should fail when opcode budget is violated');
  assert.ok(failRun.payload && failRun.payload.ok === false, 'failed run should emit failing payload');
  const failedIds = new Set((failRun.payload.checks || []).filter((row) => row.ok !== true).map((row) => row.id));
  assert.ok(failedIds.has('primitive_opcode_budget'), 'should fail primitive opcode budget check');

  const baselineCapture = run(script, repoRoot, ['capture-baseline', `--policy=${policyPath}`], env);
  assert.strictEqual(baselineCapture.status, 0, baselineCapture.stderr || 'capture-baseline should pass');
  assert.ok(baselineCapture.payload && baselineCapture.payload.ok === true, 'capture-baseline payload should be ok');

  console.log('simplicity_budget_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`simplicity_budget_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

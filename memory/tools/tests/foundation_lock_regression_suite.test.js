#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const checks = [
  {
    name: 'cargo test -p protheus-memory-core-v6',
    cmd: ['cargo', ['test', '-p', 'protheus-memory-core-v6']]
  },
  {
    name: 'cargo test -p protheus-security-core-v1',
    cmd: ['cargo', ['test', '-p', 'protheus-security-core-v1']]
  },
  {
    name: 'foundation_lock_memory_parity.test.js',
    cmd: [process.execPath, ['memory/tools/tests/foundation_lock_memory_parity.test.js']]
  },
  {
    name: 'foundation_lock_abstraction_and_security.test.js',
    cmd: [process.execPath, ['memory/tools/tests/foundation_lock_abstraction_and_security.test.js']]
  },
  {
    name: 'vault_phase3_rust_parity.test.js',
    cmd: [process.execPath, ['memory/tools/tests/vault_phase3_rust_parity.test.js']]
  },
  {
    name: 'execution_security_gate_integration.test.js',
    cmd: [process.execPath, ['memory/tools/tests/execution_security_gate_integration.test.js']]
  },
  {
    name: 'workflow_executor_step_security_gate.test.js',
    cmd: [process.execPath, ['memory/tools/tests/workflow_executor_step_security_gate.test.js']]
  }
];

for (const check of checks) {
  const [bin, args] = check.cmd;
  const out = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (Number(out.status) !== 0) {
    const stderr = String(out.stderr || '').trim();
    const stdout = String(out.stdout || '').trim();
    console.error(`❌ foundation_lock_regression_suite.test.js: ${check.name} failed`);
    if (stderr) console.error(stderr.slice(0, 1200));
    if (stdout) console.error(stdout.slice(0, 1200));
    process.exit(1);
  }
  console.log(`   ✅ ${check.name}`);
}

console.log('foundation_lock_regression_suite.test.js: OK');

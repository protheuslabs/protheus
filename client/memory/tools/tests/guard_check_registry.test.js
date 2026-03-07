#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'guard_check_registry.js');

function parseJsonLoose(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const res = spawnSync(process.execPath, [SCRIPT, 'status'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(res.status, 0, res.stderr || 'guard_check_registry status should pass');

  const payload = parseJsonLoose(res.stdout);
  assert.ok(payload && payload.ok === true, 'registry payload should be ok');
  assert.strictEqual(payload.schema_id, 'guard_check_registry');
  assert.ok(Number(payload.merge_guard_check_count || 0) >= 80, 'expected merge guard check count floor');

  const registryApi = require(path.join(ROOT, 'systems', 'ops', 'guard_check_registry.js'));
  const registry = registryApi.loadGuardCheckRegistry();
  const validation = registryApi.validateGuardCheckRegistry(registry);
  assert.strictEqual(validation.ok, true, `validation failed: ${validation.errors.join(', ')}`);

  const plan = registryApi.buildMergeGuardPlan(registry, { skipTests: true });
  const ids = new Set(plan.map((row) => String(row && row.id || '')));
  for (const id of [
    'contract_check',
    'schema_contract_check',
    'state_kernel_status',
    'rust_memory_benchmark_consistency',
    'rust_memory_daemon_supervisor_healthcheck',
    'memory_index_freshness_gate',
    'operator_terms_ack_status'
  ]) {
    assert.ok(ids.has(id), `missing required merge_guard plan id: ${id}`);
  }

  console.log('guard_check_registry.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`guard_check_registry.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

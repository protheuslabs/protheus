#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'primitives', 'primitive_registry.js');

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

try {
  const status = spawnSync(process.execPath, [SCRIPT, 'status'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true);
  assert.ok(Number(statusPayload.opcode_count || 0) >= 10);
  assert.strictEqual(Number(statusPayload.metadata_coverage_ratio || 0), 1);
  assert.strictEqual(Number(statusPayload.migration_coverage_ratio || 0), 1);

  const describe = spawnSync(process.execPath, [SCRIPT, 'describe', '--opcode=PAYMENT_EXECUTE'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(describe.status, 0, describe.stderr || describe.stdout);
  const descPayload = parseJson(describe.stdout);
  assert.ok(descPayload && descPayload.ok === true);
  assert.strictEqual(descPayload.migration_active, true);
  assert.ok(descPayload.descriptor && descPayload.descriptor.metadata);
  assert.strictEqual(descPayload.descriptor.metadata.safety_class, 'critical');

  const audit = spawnSync(process.execPath, [SCRIPT, 'audit'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.strictEqual(audit.status, 0, audit.stderr || audit.stdout);
  const auditPayload = parseJson(audit.stdout);
  assert.ok(auditPayload && auditPayload.ok === true);

  console.log('primitive_registry.test.js: OK');
} catch (err) {
  console.error(`primitive_registry.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

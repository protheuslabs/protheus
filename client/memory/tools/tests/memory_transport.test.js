#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const transport = require(path.join(ROOT, 'systems', 'memory', 'memory_transport.js'));

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   MEMORY TRANSPORT TESTS');
  console.log('═══════════════════════════════════════════════════════════');

  await runAsyncTest('daemon success returns daemon telemetry', async () => {
    const out = await transport.runUnifiedMemoryTransport({
      daemon_enabled: true,
      invoke_daemon: async () => ({ ok: true, payload: { ok: true, hits: [] } }),
      invoke_cli: () => ({ ok: false, error: 'should_not_run' })
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.transport, 'daemon');
    assert.strictEqual(Array.isArray(out.attempts), true);
    assert.strictEqual(out.attempts.length, 1);
    assert.strictEqual(out.fallback_reason, null);
  });

  await runAsyncTest('in-process path wins when napi lane succeeds', async () => {
    const out = await transport.runUnifiedMemoryTransport({
      in_process_enabled: true,
      in_process_mode: 'napi',
      invoke_in_process: async () => ({ ok: true, payload: { ok: true, hits: [] }, module_path: '/tmp/fake.node' }),
      daemon_enabled: true,
      invoke_daemon: async () => ({ ok: false, error: 'should_not_run' })
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.transport, 'napi');
    assert.strictEqual(out.attempts.length, 1);
    assert.strictEqual(out.fallback_reason, null);
  });

  await runAsyncTest('daemon failure falls back to cli with fallback reason', async () => {
    const out = await transport.runUnifiedMemoryTransport({
      daemon_enabled: true,
      invoke_daemon: async () => ({ ok: false, error: 'rust_daemon_unavailable' }),
      invoke_cli: () => ({
        ok: true,
        payload: { ok: true, section: 'ok' },
        transport: 'cli',
        transport_detail: 'binary'
      })
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.transport, 'cli');
    assert.strictEqual(out.transport_detail, 'binary');
    assert.strictEqual(out.fallback_reason, 'rust_daemon_unavailable');
    assert.strictEqual(out.attempts.length, 2);
  });

  await runAsyncTest('cli fallback disabled fails after daemon miss', async () => {
    const out = await transport.runUnifiedMemoryTransport({
      daemon_enabled: true,
      allow_cli_fallback: false,
      invoke_daemon: async () => ({ ok: false, error: 'rust_daemon_disabled' })
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'rust_daemon_disabled');
    assert.strictEqual(out.transport, 'none');
    assert.strictEqual(out.attempts.length, 1);
  });

  runTest('normalize telemetry coerces shape', () => {
    const row = transport.normalizeTransportTelemetry({
      backend_requested: 'rust',
      backend_used: 'js',
      fallback_reason: 'Rust CLI Status 1',
      rust_transport: 'cli',
      rust_transport_detail: 'cargo_run',
      transport_attempts: [{ mode: 'daemon', ok: false, error: 'timeout' }]
    });
    assert.strictEqual(row.backend_requested, 'rust');
    assert.strictEqual(row.backend_used, 'js');
    assert.strictEqual(row.fallback_reason, 'rust_cli_status_1');
    assert.strictEqual(row.rust_transport, 'cli');
    assert.strictEqual(Array.isArray(row.transport_attempts), true);
    assert.strictEqual(row.transport_attempts.length, 1);
  });

  if (failed) process.exit(1);
  console.log('✅ memory_transport tests passed');
}

main().catch((err) => {
  console.error(`memory_transport.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

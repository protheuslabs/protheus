#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';

  const mod = resetModule(path.join(ROOT, 'client/runtime/systems/memory/session_isolation.ts'));
  const statePath = path.join(os.tmpdir(), `session-isolation-rust-${Date.now()}.json`);

  const empty = mod.loadState(statePath);
  assert.equal(empty.schema_version, '1.0');
  assert.deepEqual(empty.resources, {});

  const missing = mod.validateSessionIsolation(['query-index', '--resource-id=node-1'], { statePath });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason_code, 'missing_session_id');

  const allowed = mod.validateSessionIsolation(
    ['query-index', '--session-id=session-a', '--resource-id=node-1'],
    { statePath }
  );
  assert.equal(allowed.ok, true);

  const saved = mod.loadState(statePath);
  assert.equal(saved.resources['resource-id:node-1'].session_id, 'session-a');

  const blocked = mod.validateSessionIsolation(
    ['query-index', '--session-id=session-b', '--resource-id=node-1'],
    { statePath }
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason_code, 'cross_session_leak_blocked');

  const rejection = mod.sessionFailureResult(blocked, { stage: 'bridge_test' });
  assert.equal(rejection.ok, false);
  assert.equal(rejection.status, 2);
  assert.match(String(rejection.stderr), /cross_session_leak_blocked/);

  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  console.log(JSON.stringify({ ok: true, type: 'session_isolation_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}

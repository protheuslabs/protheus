#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function assertIsoLike(value, label) {
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(value || '')), `${label} should be ISO-like`);
  assert.ok(Number.isFinite(Date.parse(String(value || ''))), `${label} should parse as date`);
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  assertIsoLike(ts.nowIso(), 'ts.nowIso');
  assertIsoLike(rust.nowIso(), 'rust.nowIso');

  assert.deepStrictEqual(rust.defaultTierEventMap(), ts.defaultTierEventMap(), 'defaultTierEventMap mismatch');

  const coerceInput = {
    tactical: ['2026-03-01T00:00:00.000Z', 123],
    belief: ['x'],
    ignored_key: ['z']
  };
  assert.deepStrictEqual(rust.coerceTierEventMap(coerceInput), ts.coerceTierEventMap(coerceInput), 'coerceTierEventMap mismatch');

  const tsHarness = ts.defaultHarnessState();
  const rustHarness = rust.defaultHarnessState();
  assert.strictEqual(rustHarness.schema_id, tsHarness.schema_id, 'defaultHarnessState schema_id mismatch');
  assert.strictEqual(rustHarness.schema_version, tsHarness.schema_version, 'defaultHarnessState schema_version mismatch');
  assert.strictEqual(rustHarness.cursor, tsHarness.cursor, 'defaultHarnessState cursor mismatch');
  assert.strictEqual(rustHarness.last_run_ts, tsHarness.last_run_ts, 'defaultHarnessState last_run_ts mismatch');

  const tsLock = ts.defaultFirstPrincipleLockState();
  const rustLock = rust.defaultFirstPrincipleLockState();
  assert.strictEqual(rustLock.schema_id, tsLock.schema_id, 'defaultFirstPrincipleLockState schema_id mismatch');
  assert.strictEqual(rustLock.schema_version, tsLock.schema_version, 'defaultFirstPrincipleLockState schema_version mismatch');
  assert.deepStrictEqual(rustLock.locks, tsLock.locks, 'defaultFirstPrincipleLockState locks mismatch');

  const tsMaturity = ts.defaultMaturityState();
  const rustMaturity = rust.defaultMaturityState();
  assert.strictEqual(rustMaturity.schema_id, tsMaturity.schema_id, 'defaultMaturityState schema_id mismatch');
  assert.strictEqual(rustMaturity.schema_version, tsMaturity.schema_version, 'defaultMaturityState schema_version mismatch');
  assert.deepStrictEqual(rustMaturity.stats, tsMaturity.stats, 'defaultMaturityState stats mismatch');
  assert.deepStrictEqual(rustMaturity.recent_tests, tsMaturity.recent_tests, 'defaultMaturityState recent_tests mismatch');
  assert.strictEqual(rustMaturity.score, tsMaturity.score, 'defaultMaturityState score mismatch');
  assert.strictEqual(rustMaturity.band, tsMaturity.band, 'defaultMaturityState band mismatch');

  const session = {
    objective: 'Harden migration lane',
    objective_id: 'BL-209',
    target: 'directive'
  };
  assert.strictEqual(rust.principleKeyForSession(session), ts.principleKeyForSession(session), 'principleKeyForSession mismatch');

  assert.strictEqual(
    rust.normalizeObjectiveArg('   migrate   the next lane   '),
    ts.normalizeObjectiveArg('   migrate   the next lane   '),
    'normalizeObjectiveArg mismatch'
  );

  assert.deepStrictEqual(rust.maturityBandOrder(), ts.maturityBandOrder(), 'maturityBandOrder mismatch');

  const args = { mode: 'test' };
  const policy = { runtime: { mode: 'live' } };
  delete process.env.INVERSION_RUNTIME_MODE;
  assert.strictEqual(rust.currentRuntimeMode(args, policy), ts.currentRuntimeMode(args, policy), 'currentRuntimeMode args mismatch');

  process.env.INVERSION_RUNTIME_MODE = 'live';
  assert.strictEqual(rust.currentRuntimeMode({}, { runtime: { mode: 'test' } }), ts.currentRuntimeMode({}, { runtime: { mode: 'test' } }), 'currentRuntimeMode env mismatch');
  delete process.env.INVERSION_RUNTIME_MODE;

  const sharedStateTs = { scopes: {} };
  const sharedStateRust = { scopes: {} };
  const scopeTs = ts.getTierScope(sharedStateTs, '2.0');
  const scopeRust = rust.getTierScope(sharedStateRust, '2.0');
  assert.deepStrictEqual(scopeRust, scopeTs, 'getTierScope scope mismatch');
  assert.deepStrictEqual(sharedStateRust, sharedStateTs, 'getTierScope state mutation mismatch');

  console.log('inversion_helper_batch7_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch7_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

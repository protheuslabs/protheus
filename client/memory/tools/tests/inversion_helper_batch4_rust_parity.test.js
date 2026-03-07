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

function stripDynamicState(state) {
  return {
    schema_id: state.schema_id,
    schema_version: state.schema_version,
    active_policy_version: state.active_policy_version,
    scopes: state.scopes
  };
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const eventsInput = ['2026-03-04T00:00:00.000Z', 'bad', '2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z'];
  assert.deepStrictEqual(
    rust.normalizeIsoEvents(eventsInput, 10000),
    ts.normalizeIsoEvents(eventsInput, 10000),
    'normalizeIsoEvents mismatch'
  );

  assert.deepStrictEqual(
    rust.expandLegacyCountToEvents(3, '2026-03-04T00:00:00.000Z'),
    ts.expandLegacyCountToEvents(3, '2026-03-04T00:00:00.000Z'),
    'expandLegacyCountToEvents mismatch'
  );

  const srcMap = { tactical: ['2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z'] };
  const fallbackMap = ts.defaultTierEventMap();
  const legacyCounts = { belief: 2 };
  assert.deepStrictEqual(
    rust.normalizeTierEventMap(srcMap, fallbackMap, legacyCounts, '2026-03-04T00:00:00.000Z'),
    ts.normalizeTierEventMap(srcMap, fallbackMap, legacyCounts, '2026-03-04T00:00:00.000Z'),
    'normalizeTierEventMap mismatch'
  );

  const legacy = {
    live_apply_counts: { tactical: 1 },
    shadow_pass_counts: { identity: 2 }
  };
  assert.deepStrictEqual(
    rust.defaultTierScope(legacy, '2026-03-04T00:00:00.000Z'),
    ts.defaultTierScope(legacy, '2026-03-04T00:00:00.000Z'),
    'defaultTierScope mismatch'
  );

  const scopeInput = {
    shadow_passes: {
      identity: ['2026-03-04T00:00:00.000Z']
    }
  };
  assert.deepStrictEqual(
    rust.normalizeTierScope(scopeInput, legacy, '2026-03-04T00:00:00.000Z'),
    ts.normalizeTierScope(scopeInput, legacy, '2026-03-04T00:00:00.000Z'),
    'normalizeTierScope mismatch'
  );

  const tsState = stripDynamicState(ts.defaultTierGovernanceState('1.2'));
  const rustState = stripDynamicState(rust.defaultTierGovernanceState('1.2'));
  assert.deepStrictEqual(rustState, tsState, 'defaultTierGovernanceState mismatch');

  assert.deepStrictEqual(
    rust.cloneTierScope(scopeInput),
    ts.cloneTierScope(scopeInput),
    'cloneTierScope mismatch'
  );

  const pruneInput = {
    live_apply_attempts: {
      tactical: ['2000-01-01T00:00:00.000Z', '2026-03-04T00:00:00.000Z']
    },
    live_apply_successes: ts.defaultTierEventMap(),
    live_apply_safe_aborts: ts.defaultTierEventMap(),
    shadow_passes: ts.defaultTierEventMap(),
    shadow_critical_failures: ts.defaultTierEventMap()
  };
  assert.deepStrictEqual(
    rust.pruneTierScopeEvents(pruneInput, 365),
    ts.pruneTierScopeEvents(pruneInput, 365),
    'pruneTierScopeEvents mismatch'
  );

  const countScope = {
    live_apply_attempts: {
      tactical: ['2026-03-04T00:00:00.000Z', '2026-03-03T00:00:00.000Z']
    }
  };
  assert.strictEqual(
    rust.countTierEvents(countScope, 'live_apply_attempts', 'tactical', 3650),
    ts.countTierEvents(countScope, 'live_apply_attempts', 'tactical', 3650),
    'countTierEvents mismatch'
  );

  assert.strictEqual(
    rust.effectiveWindowDaysForTarget({ identity: 30 }, { identity: 45 }, 'identity', 90),
    ts.effectiveWindowDaysForTarget({ identity: 30 }, { identity: 45 }, 'identity', 90),
    'effectiveWindowDaysForTarget mismatch'
  );

  console.log('inversion_helper_batch4_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch4_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

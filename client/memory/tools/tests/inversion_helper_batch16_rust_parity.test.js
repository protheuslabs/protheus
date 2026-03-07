#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
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

function eventCount(state, metric, target) {
  const scopes = state && state.scopes && typeof state.scopes === 'object' ? state.scopes : {};
  const version = String(state && state.active_policy_version || '1.0');
  const scope = scopes[version] && typeof scopes[version] === 'object' ? scopes[version] : {};
  const map = scope[metric] && typeof scope[metric] === 'object' ? scope[metric] : {};
  const rows = Array.isArray(map[target]) ? map[target] : [];
  return rows.length;
}

function lockRow(state, key) {
  const locks = state && state.locks && typeof state.locks === 'object' ? state.locks : {};
  return locks[key] && typeof locks[key] === 'object' ? locks[key] : null;
}

function stripTs(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  delete out.ts;
  return out;
}

function run() {
  const tmpRoot = path.join(REPO_ROOT, 'tmp', 'inversion-batch16-parity');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const mkPaths = (prefix) => {
    const stateDir = path.join(tmpRoot, prefix, 'state');
    fs.mkdirSync(path.join(stateDir, 'first_principles'), { recursive: true });
    return {
      tier_governance_path: path.join(stateDir, 'tier_governance.json'),
      first_principles_lock_path: path.join(stateDir, 'first_principles', 'lock_state.json')
    };
  };

  const tsPaths = mkPaths('ts');
  const rustPaths = mkPaths('rust');

  const policy = {
    version: '1.7',
    tier_transition: {
      window_days_by_target: { tactical: 45, directive: 90 },
      minimum_window_days_by_target: { tactical: 30, directive: 60 }
    },
    shadow_pass_gate: {
      window_days_by_target: { tactical: 60, directive: 120 }
    },
    first_principles: {
      anti_downgrade: {
        enabled: true,
        require_same_or_higher_maturity: true,
        prevent_lower_confidence_same_band: true,
        same_band_confidence_floor_ratio: 0.92
      }
    }
  };

  const baseState = {
    schema_id: 'inversion_tier_governance_state',
    schema_version: '1.0',
    active_policy_version: '1.7',
    scopes: {
      '1.7': {
        live_apply_attempts: { tactical: ['2026-03-04T00:00:00.000Z'] },
        live_apply_successes: { tactical: [] },
        live_apply_safe_aborts: { tactical: [] },
        shadow_passes: { tactical: [] },
        shadow_critical_failures: { tactical: [] }
      }
    }
  };

  const tsSaved = ts.saveTierGovernanceState(tsPaths, baseState, '1.7', 3650);
  const rustSaved = rust.saveTierGovernanceState(rustPaths, baseState, '1.7', 3650);
  assert.strictEqual(tsSaved.active_policy_version, rustSaved.active_policy_version, 'saveTierGovernanceState policy mismatch');
  assert.strictEqual(eventCount(tsSaved, 'live_apply_attempts', 'tactical'), eventCount(rustSaved, 'live_apply_attempts', 'tactical'), 'saveTierGovernanceState event count mismatch');

  const tsLoaded = ts.loadTierGovernanceState(tsPaths, '1.7');
  const rustLoaded = rust.loadTierGovernanceState(rustPaths, '1.7');
  assert.strictEqual(tsLoaded.active_policy_version, rustLoaded.active_policy_version, 'loadTierGovernanceState policy mismatch');
  assert.strictEqual(eventCount(tsLoaded, 'live_apply_attempts', 'tactical'), eventCount(rustLoaded, 'live_apply_attempts', 'tactical'), 'loadTierGovernanceState event count mismatch');

  const tsMap = { tactical: [] };
  const rustMap = { tactical: [] };
  ts.pushTierEvent(tsMap, 'directive', '2026-03-04T12:00:00.000Z');
  rust.pushTierEvent(rustMap, 'directive', '2026-03-04T12:00:00.000Z');
  assert.deepStrictEqual(rustMap, tsMap, 'pushTierEvent mismatch');

  const tsAdded = ts.addTierEvent(tsPaths, policy, 'live_apply_attempts', 'directive', '2026-03-04T12:00:00.000Z');
  const rustAdded = rust.addTierEvent(rustPaths, policy, 'live_apply_attempts', 'directive', '2026-03-04T12:00:00.000Z');
  assert.strictEqual(eventCount(tsAdded, 'live_apply_attempts', 'directive'), eventCount(rustAdded, 'live_apply_attempts', 'directive'), 'addTierEvent mismatch');

  const tsAttempt = ts.incrementLiveApplyAttempt(tsPaths, policy, 'belief');
  const rustAttempt = rust.incrementLiveApplyAttempt(rustPaths, policy, 'belief');
  assert.strictEqual(eventCount(tsAttempt, 'live_apply_attempts', 'belief'), eventCount(rustAttempt, 'live_apply_attempts', 'belief'), 'incrementLiveApplyAttempt mismatch');

  const tsSuccess = ts.incrementLiveApplySuccess(tsPaths, policy, 'belief');
  const rustSuccess = rust.incrementLiveApplySuccess(rustPaths, policy, 'belief');
  assert.strictEqual(eventCount(tsSuccess, 'live_apply_successes', 'belief'), eventCount(rustSuccess, 'live_apply_successes', 'belief'), 'incrementLiveApplySuccess mismatch');

  const tsAbort = ts.incrementLiveApplySafeAbort(tsPaths, policy, 'belief');
  const rustAbort = rust.incrementLiveApplySafeAbort(rustPaths, policy, 'belief');
  assert.strictEqual(eventCount(tsAbort, 'live_apply_safe_aborts', 'belief'), eventCount(rustAbort, 'live_apply_safe_aborts', 'belief'), 'incrementLiveApplySafeAbort mismatch');

  const session = { mode: 'test', apply_requested: false, target: 'directive' };
  const tsShadow = ts.updateShadowTrialCounters(tsPaths, policy, session, 'success', false);
  const rustShadow = rust.updateShadowTrialCounters(rustPaths, policy, session, 'success', false);
  assert.strictEqual(eventCount(tsShadow, 'shadow_passes', 'directive'), eventCount(rustShadow, 'shadow_passes', 'directive'), 'updateShadowTrialCounters success mismatch');

  const tsShadowFail = ts.updateShadowTrialCounters(tsPaths, policy, session, 'destructive', true);
  const rustShadowFail = rust.updateShadowTrialCounters(rustPaths, policy, session, 'destructive', true);
  assert.strictEqual(eventCount(tsShadowFail, 'shadow_critical_failures', 'directive'), eventCount(rustShadowFail, 'shadow_critical_failures', 'directive'), 'updateShadowTrialCounters destructive mismatch');

  const fpSession = {
    objective_id: 'BL-246',
    objective: 'Guard principle quality',
    target: 'directive',
    maturity_band: 'mature'
  };
  const principle = { id: 'fp_guard', confidence: 0.91 };
  ts.upsertFirstPrincipleLock(tsPaths, fpSession, principle);
  rust.upsertFirstPrincipleLock(rustPaths, fpSession, principle);

  const tsLockState = ts.loadFirstPrincipleLockState(tsPaths);
  const rustLockState = rust.loadFirstPrincipleLockState(rustPaths);
  const key = ts.principleKeyForSession(fpSession);
  assert.strictEqual(key, rust.principleKeyForSession(fpSession), 'principle key mismatch');
  assert.deepStrictEqual(stripTs(lockRow(rustLockState, key)), stripTs(lockRow(tsLockState, key)), 'upsertFirstPrincipleLock mismatch');

  const lowerSession = { ...fpSession, maturity_band: 'developing' };
  const tsCheck = ts.checkFirstPrincipleDowngrade(tsPaths, policy, lowerSession, 0.5);
  const rustCheck = rust.checkFirstPrincipleDowngrade(rustPaths, policy, lowerSession, 0.5);
  assert.strictEqual(rustCheck.allowed, tsCheck.allowed, 'checkFirstPrincipleDowngrade allowed mismatch');
  assert.strictEqual(rustCheck.reason, tsCheck.reason, 'checkFirstPrincipleDowngrade reason mismatch');
  assert.strictEqual(rustCheck.key, tsCheck.key, 'checkFirstPrincipleDowngrade key mismatch');

  console.log('inversion_helper_batch16_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch16_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

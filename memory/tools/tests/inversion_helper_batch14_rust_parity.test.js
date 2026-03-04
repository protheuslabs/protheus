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

function withoutUpdatedAt(row) {
  const out = { ...(row || {}) };
  delete out.updated_at;
  return out;
}

function run() {
  const tmpRoot = path.join(REPO_ROOT, 'tmp', 'inversion-batch14-parity');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const stateDir = path.join(tmpRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  process.env.INVERSION_STATE_DIR = stateDir;
  process.env.DUAL_BRAIN_POLICY_PATH = path.join(tmpRoot, 'dual_brain_policy.json');

  const policyPath = path.join(tmpRoot, 'policy_batch14.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    immutable_axioms: {
      enabled: true,
      axioms: [
        {
          id: ' AXIOM_1 ',
          patterns: ['Do not betray user intent', ''],
          regex: ['^never\\s+betray'],
          intent_tags: [' alignment ', 'security'],
          signals: {
            action_terms: ['betray'],
            subject_terms: ['system'],
            object_terms: ['user']
          },
          min_signal_groups: 2,
          semantic_requirements: {
            actions: ['protect'],
            subjects: ['human'],
            objects: ['sovereignty']
          }
        }
      ]
    },
    maturity_harness: {
      suite: [
        {
          id: ' HARNESS_1 ',
          objective: 'Validate convergence path',
          impact: 'high',
          target: 'belief',
          difficulty: 'hard'
        }
      ]
    }
  }, null, 2));

  const tsPolicy = ts.loadPolicy(policyPath);
  const rustPolicy = rust.loadPolicy(policyPath);

  assert.deepStrictEqual(
    rustPolicy.immutable_axioms.axioms,
    tsPolicy.immutable_axioms.axioms,
    'immutable axioms normalization mismatch'
  );
  assert.deepStrictEqual(
    rustPolicy.maturity_harness.suite,
    tsPolicy.maturity_harness.suite,
    'maturity harness suite normalization mismatch'
  );

  const paths = ts.runtimePaths(policyPath);

  const harnessInput = { last_run_ts: '2026-03-04T12:00:00.000Z', cursor: 11 };
  const tsSavedHarness = ts.saveHarnessState(paths, harnessInput);
  const rustSavedHarness = rust.saveHarnessState(paths, harnessInput);
  assert.deepStrictEqual(
    withoutUpdatedAt(rustSavedHarness),
    withoutUpdatedAt(tsSavedHarness),
    'saveHarnessState mismatch'
  );
  assert.deepStrictEqual(
    rust.loadHarnessState(paths),
    ts.loadHarnessState(paths),
    'loadHarnessState mismatch'
  );

  const lockInput = { locks: { 'belief::abc123': { confidence: 0.9 } } };
  const tsSavedLock = ts.saveFirstPrincipleLockState(paths, lockInput);
  const rustSavedLock = rust.saveFirstPrincipleLockState(paths, lockInput);
  assert.deepStrictEqual(
    withoutUpdatedAt(rustSavedLock),
    withoutUpdatedAt(tsSavedLock),
    'saveFirstPrincipleLockState mismatch'
  );
  assert.deepStrictEqual(
    rust.loadFirstPrincipleLockState(paths),
    ts.loadFirstPrincipleLockState(paths),
    'loadFirstPrincipleLockState mismatch'
  );

  fs.rmSync(paths.observer_approvals_path, { force: true });
  const tsApproval = ts.appendObserverApproval(paths, {
    target: 'belief',
    observer_id: 'Observer_A',
    note: 'first pass'
  });
  const rustApproval = rust.appendObserverApproval(paths, {
    target: 'belief',
    observer_id: 'Observer_A',
    note: 'first pass'
  });
  assert.strictEqual(rustApproval.type, tsApproval.type, 'appendObserverApproval type mismatch');
  assert.strictEqual(rustApproval.target, tsApproval.target, 'appendObserverApproval target mismatch');
  assert.strictEqual(rustApproval.observer_id, tsApproval.observer_id, 'appendObserverApproval observer mismatch');
  assert.strictEqual(rustApproval.note, tsApproval.note, 'appendObserverApproval note mismatch');
  assert.deepStrictEqual(
    rust.loadObserverApprovals(paths),
    ts.loadObserverApprovals(paths),
    'loadObserverApprovals mismatch'
  );
  assert.strictEqual(
    rust.countObserverApprovals(paths, 'belief', 365),
    ts.countObserverApprovals(paths, 'belief', 365),
    'countObserverApprovals mismatch'
  );

  const correspondencePath = path.join(tmpRoot, 'personas', 'vikram', 'correspondence.md');
  fs.rmSync(correspondencePath, { force: true });
  ts.ensureCorrespondenceFile(correspondencePath);
  fs.rmSync(correspondencePath, { force: true });
  rust.ensureCorrespondenceFile(correspondencePath);
  assert.strictEqual(
    fs.readFileSync(correspondencePath, 'utf8'),
    '# Shadow Conclave Correspondence\n\n',
    'ensureCorrespondenceFile header mismatch'
  );

  console.log('inversion_helper_batch14_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch14_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

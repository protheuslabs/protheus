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

function run() {
  const tmpRoot = path.join(REPO_ROOT, 'tmp', 'inversion-batch13-parity');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const stateDir = path.join(tmpRoot, 'state');
  const jsonPath = path.join(stateDir, 'sample.json');
  const jsonlPath = path.join(stateDir, 'sample.jsonl');

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  ts.ensureDir(stateDir);
  rust.ensureDir(stateDir);

  ts.writeJsonAtomic(jsonPath, { a: 1, b: 'x' });
  assert.deepStrictEqual(
    rust.readJson(jsonPath, {}),
    ts.readJson(jsonPath, {}),
    'readJson mismatch'
  );

  ts.appendJsonl(jsonlPath, { k: 1 });
  ts.appendJsonl(jsonlPath, { k: 2 });
  assert.deepStrictEqual(
    rust.readJsonl(jsonlPath),
    ts.readJsonl(jsonlPath),
    'readJsonl mismatch'
  );

  assert.strictEqual(
    rust.readText(jsonPath, ''),
    ts.readText(jsonPath, ''),
    'readText mismatch'
  );

  assert.strictEqual(
    rust.latestJsonFileInDir(stateDir),
    ts.latestJsonFileInDir(stateDir),
    'latestJsonFileInDir mismatch'
  );

  process.env.INVERSION_STATE_DIR = stateDir;
  process.env.DUAL_BRAIN_POLICY_PATH = path.join(tmpRoot, 'dual_brain_policy.json');
  assert.deepStrictEqual(
    rust.runtimePaths(path.join(tmpRoot, 'policy.json')),
    ts.runtimePaths(path.join(tmpRoot, 'policy.json')),
    'runtimePaths mismatch'
  );

  const policyPath = path.join(tmpRoot, 'policy_custom.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    output_interfaces: {
      code_change_proposal: {
        enabled: true,
        test_enabled: true,
        live_enabled: false,
        require_sandbox_verification: true,
        require_explicit_emit: true
      }
    },
    paths: {
      receipts_path: 'state/custom_receipts.jsonl',
      observer_approvals_path: 'state/custom_observers.jsonl'
    }
  }, null, 2));

  const tsPolicy = ts.loadPolicy(policyPath);
  const rustPolicy = rust.loadPolicy(policyPath);

  assert.deepStrictEqual(
    rustPolicy.output_interfaces,
    tsPolicy.output_interfaces,
    'loadPolicy output_interfaces mismatch'
  );
  assert.deepStrictEqual(
    rustPolicy.paths,
    tsPolicy.paths,
    'loadPolicy paths mismatch'
  );

  console.log('inversion_helper_batch13_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch13_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

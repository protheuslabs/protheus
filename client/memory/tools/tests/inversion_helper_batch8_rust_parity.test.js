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
  const tempDir = path.join(REPO_ROOT, 'tmp', 'inversion-batch8-parity');
  fs.mkdirSync(tempDir, { recursive: true });

  const driftPath = path.join(tempDir, 'drift.json');
  const parityPath = path.join(tempDir, 'parity.json');
  fs.writeFileSync(driftPath, JSON.stringify({ drift_rate: 0.1333333 }, null, 2));
  fs.writeFileSync(parityPath, JSON.stringify({ parity_confidence: 0.8444444 }, null, 2));

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  assert.deepStrictEqual(
    rust.readDriftFromStateFile(driftPath),
    ts.readDriftFromStateFile(driftPath),
    'readDriftFromStateFile mismatch'
  );

  const driftPolicy = {
    persona_lens_gate: {
      paths: {
        drift_source_path: driftPath
      }
    },
    organ: {
      trigger_detection: {
        paths: {
          drift_governor_path: ''
        }
      }
    }
  };

  assert.deepStrictEqual(
    rust.resolveLensGateDrift({}, driftPolicy),
    ts.resolveLensGateDrift({}, driftPolicy),
    'resolveLensGateDrift mismatch (policy path)'
  );

  assert.deepStrictEqual(
    rust.resolveLensGateDrift({ drift_rate: '0.2' }, driftPolicy),
    ts.resolveLensGateDrift({ drift_rate: '0.2' }, driftPolicy),
    'resolveLensGateDrift mismatch (arg)'
  );

  const parityPolicy = {
    persona_lens_gate: {
      paths: {
        parity_confidence_path: parityPath
      }
    }
  };

  assert.deepStrictEqual(
    rust.resolveParityConfidence({}, parityPolicy),
    ts.resolveParityConfidence({}, parityPolicy),
    'resolveParityConfidence mismatch (policy path)'
  );

  assert.deepStrictEqual(
    rust.resolveParityConfidence({ parity_score: '0.65' }, parityPolicy),
    ts.resolveParityConfidence({ parity_score: '0.65' }, parityPolicy),
    'resolveParityConfidence mismatch (arg)'
  );

  console.log('inversion_helper_batch8_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch8_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

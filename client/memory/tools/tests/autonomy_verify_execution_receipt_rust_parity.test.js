#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const RUST_BIN = path.join(REPO_ROOT, 'target', 'release', 'execution_core');

function runWithRustFlag(flag, payload) {
  const script = `
    const controller = require(process.env.CONTROLLER_PATH);
    const args = JSON.parse(process.env.PAYLOAD_JSON || '{}');
    const out = controller.verifyExecutionReceipt(
      args.execRes,
      args.dod,
      args.outcomeRes,
      args.postconditions,
      args.successCriteria
    );
    process.stdout.write(JSON.stringify(out));
  `;
  const run = spawnSync('node', ['-e', script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED: String(flag),
      PROTHEUS_EXECUTION_RUST_BIN: RUST_BIN,
      CONTROLLER_PATH,
      PAYLOAD_JSON: JSON.stringify(payload)
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (Number(run.status) !== 0) {
    throw new Error((run.stderr || run.stdout || 'verifyExecutionReceipt failed').slice(0, 300));
  }
  return JSON.parse(run.stdout || 'null');
}

function normalize(obj) {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = normalize(obj[key]);
  return out;
}

function assertParity(payload, label) {
  const legacy = runWithRustFlag(0, payload);
  const rust = runWithRustFlag(1, payload);
  assert.deepStrictEqual(normalize(rust), normalize(legacy), `${label}: rust parity drift`);
}

function run() {
  const base = {
    execRes: {
      ok: true,
      summary: { decision: 'ROUTE' },
      execution_metrics: { route_model_attestation: { status: 'ok', expected_model: '', observed_model: '' } }
    },
    dod: { passed: true },
    outcomeRes: { ok: true },
    postconditions: { passed: true },
    successCriteria: { required: false, passed: true }
  };

  assertParity({
    ...base,
    execRes: {
      ...base.execRes,
      ok: false,
      summary: { decision: 'ACTUATE' }
    }
  }, 'reverted_on_exec_fail');

  assertParity({
    ...base,
    dod: { passed: false }
  }, 'no_change_on_dod_fail');

  assertParity({
    ...base,
    execRes: {
      ...base.execRes,
      execution_metrics: {
        route_model_attestation: { status: 'mismatch', expected_model: 'gpt-5', observed_model: 'gpt-4.1' }
      }
    }
  }, 'reverted_on_attestation_mismatch');

  console.log('autonomy_verify_execution_receipt_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_verify_execution_receipt_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

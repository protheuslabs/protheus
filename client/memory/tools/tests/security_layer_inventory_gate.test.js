#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'security_layer_inventory_gate.js');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'security_layer_inventory.json');
const GENERATED_DOC = path.join(ROOT, 'docs', 'security', 'SECURITY_LAYER_INVENTORY.md');

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv
    }
  });
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`❌ security_layer_inventory_gate.test.js: ${msg}`);
  process.exit(1);
}

function assert(condition, msg) {
  if (!condition) fail(msg);
}

function main() {
  const strictRun = run(['run', '--strict=1', '--write=1']);
  assert(strictRun.status === 0, `strict run failed: ${String(strictRun.stderr || '').slice(0, 240)}`);
  const strictPayload = parseJson(strictRun.stdout);
  assert(strictPayload && strictPayload.ok === true, 'strict payload not ok');
  assert(Number(strictPayload.summary.layer_count || 0) >= 1, 'layer_count missing');
  assert(fs.existsSync(GENERATED_DOC), 'generated inventory doc missing');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-layer-inventory-test-'));
  const badConfig = path.join(tempDir, 'inventory.json');
  const config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG, 'utf8'));
  config.layers.push({
    id: 'invalid_layer_for_test',
    title: 'Invalid Layer for Test',
    implementation_paths: ['does/not/exist.ts'],
    policy_paths: [],
    guard_check_ids: ['nonexistent_guard_check'],
    test_paths: []
  });
  fs.writeFileSync(badConfig, `${JSON.stringify(config, null, 2)}\n`);

  const nonStrictBad = run(['run', '--strict=0', '--write=0'], {
    SECURITY_LAYER_INVENTORY_PATH: badConfig
  });
  assert(nonStrictBad.status === 0, 'non-strict bad run should not fail');
  const nonStrictPayload = parseJson(nonStrictBad.stdout);
  assert(nonStrictPayload && nonStrictPayload.ok === false, 'non-strict bad payload should be fail');
  assert((nonStrictPayload.missing_references || []).length >= 2, 'missing references not detected');

  const strictBad = run(['run', '--strict=1', '--write=0'], {
    SECURITY_LAYER_INVENTORY_PATH: badConfig
  });
  assert(strictBad.status !== 0, 'strict bad run should fail');

  console.log('security_layer_inventory_gate.test.js: OK');
}

main();

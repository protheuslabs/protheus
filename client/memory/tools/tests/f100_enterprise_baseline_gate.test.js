#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'f100_enterprise_baseline_gate.js');
const DEFAULT_CONTRACT = path.join(ROOT, 'config', 'f100_enterprise_baseline_contract.json');
const GENERATED_DOC = path.join(ROOT, 'docs', 'ops', 'F100_ENTERPRISE_BASELINE_STATUS.md');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`f100_enterprise_baseline_gate.test.js FAILED: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function main() {
  const strict = run(['run', '--strict=1', '--write=1']);
  assert(strict.status === 0, `strict run should pass: ${strict.stderr}`);
  const strictPayload = parseJson(strict.stdout);
  assert(strictPayload && strictPayload.ok === true, 'strict payload should be ok');
  assert(fs.existsSync(GENERATED_DOC), 'baseline doc should be generated');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f100-baseline-contract-'));
  const badContractPath = path.join(tempDir, 'bad-contract.json');
  const badContract = JSON.parse(fs.readFileSync(DEFAULT_CONTRACT, 'utf8'));
  badContract.checks.push({
    id: 'forced_missing_file',
    type: 'file_exists',
    path: 'missing/path/for-test.txt'
  });
  fs.writeFileSync(badContractPath, `${JSON.stringify(badContract, null, 2)}\n`);

  const badNonStrict = run(['run', '--strict=0', '--write=0'], {
    F100_BASELINE_CONTRACT_PATH: badContractPath
  });
  assert(badNonStrict.status === 0, 'non-strict bad contract run should not fail');
  const badPayload = parseJson(badNonStrict.stdout);
  assert(badPayload && badPayload.ok === false, 'bad payload should fail contract');

  const badStrict = run(['run', '--strict=1', '--write=0'], {
    F100_BASELINE_CONTRACT_PATH: badContractPath
  });
  assert(badStrict.status !== 0, 'strict bad contract run should fail');

  console.log('f100_enterprise_baseline_gate.test.js: OK');
}

main();

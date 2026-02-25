#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'external_security_cycle.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(text) {
  return JSON.parse(String(text || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'external-security-cycle-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state', 'security', 'external_assessment');
  const reportPath = path.join(tmp, 'report.json');

  writeJson(policyPath, {
    version: '1.0',
    required_fields: ['id', 'severity', 'title', 'status'],
    status_closed_values: ['closed', 'resolved', 'verified'],
    severity_order: ['critical', 'high', 'medium', 'low', 'info']
  });

  writeJson(reportPath, {
    findings: [
      { id: 'F-001', severity: 'high', title: 'Auth bypass', status: 'open' },
      { id: 'F-002', severity: 'medium', title: 'Rate-limit weak', status: 'resolved' }
    ]
  });

  const env = {
    EXTERNAL_SECURITY_CYCLE_POLICY_PATH: policyPath,
    EXTERNAL_SECURITY_CYCLE_STATE_DIR: stateDir
  };

  let r = runCmd(['ingest', `--report-file=${reportPath}`, '--assessor=unit_test_vendor'], env);
  assert.strictEqual(r.status, 0, `ingest should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(Number(out.ingested_findings), 2);

  r = runCmd(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(Number(out.findings_total), 2);
  assert.strictEqual(Number(out.findings_open), 1);
  assert.ok(out.severity_counts && Number(out.severity_counts.high || 0) === 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('external_security_cycle.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`external_security_cycle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_intake_quality_gate.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-intake-gate-'));
  const backlogPath = path.join(tmp, 'UPGRADE_BACKLOG.md');
  const policyPath = path.join(tmp, 'config', 'backlog_intake_quality_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'backlog_intake_quality', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'backlog_intake_quality', 'history.jsonl');

  write(backlogPath, [
    '# Backlog',
    '',
    '## X AI Feature Abstraction Intake',
    '',
    '| ID | Status | Class | Upgrade Name | Why | Exit Criteria |',
    '|---|---|---|---|---|---|',
    '| V3-X-001 | todo | primitive | Example Primitive | Test lane | Exit done |',
    '',
    'Dependency notes:',
    '- V3-X-001 depends on V3-TASK-001',
    '',
    'Duplicate/hardening mapping:',
    '- none',
    ''
  ].join('\n'));

  writeJson(policyPath, {
    schema_id: 'backlog_intake_quality_policy',
    schema_version: '1.0-test',
    enabled: true,
    strict_default: false,
    backlog_path: backlogPath,
    target_sections: ['X AI Feature Abstraction Intake'],
    required_class_values: ['primitive', 'primitive-upgrade', 'extension', 'hardening'],
    require_dependency_notes: true,
    require_duplicate_mapping: true,
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    BACKLOG_INTAKE_QUALITY_ROOT: tmp,
    BACKLOG_INTAKE_QUALITY_POLICY_PATH: policyPath
  };

  let out = run(['run', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'backlog intake gate should pass strict');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'gate payload should be ok');
  assert.strictEqual(payload.gate.failed_sections, 0, 'no section should fail');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  write(backlogPath, [
    '# Backlog',
    '',
    '## X AI Feature Abstraction Intake',
    '',
    '| ID | Status | Class | Upgrade Name | Why | Exit Criteria |',
    '|---|---|---|---|---|---|',
    '| V3-X-001 | todo | bespoke | Example Primitive | Test lane | Exit done |',
    ''
  ].join('\n'));

  out = run(['run', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict run should complete');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'gate should fail with invalid class and missing notes');
  assert.ok(
    Array.isArray(payload.gate.sections) &&
      payload.gate.sections[0] &&
      Array.isArray(payload.gate.sections[0].violations) &&
      payload.gate.sections[0].violations.includes('dependency_notes_missing'),
    'dependency notes violation should be present'
  );
  assert.ok(
    payload.gate.sections[0].violations.some((v) => String(v).startsWith('row_class_invalid')),
    'invalid class violation should be present'
  );

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should execute');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.payload && payload.payload.type === 'backlog_intake_quality_gate', 'status should expose latest run');

  console.log('backlog_intake_quality_gate.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`backlog_intake_quality_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

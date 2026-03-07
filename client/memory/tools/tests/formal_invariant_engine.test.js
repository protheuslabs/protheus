#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'formal_invariant_engine.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
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

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof proc.status === 'number' ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-invariants-'));
  const textFile = path.join(tmp, 'rules.txt');
  const jsonFile = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'history.jsonl');
  const specPath = path.join(tmp, 'spec.json');

  writeText(textFile, 'alpha\nbeta\ngamma\n');
  writeJson(jsonFile, {
    nested: { count: 3 },
    modes: ['a', 'b', 'c'],
    enabled: true
  });

  writeJson(specPath, {
    schema_id: 'formal_invariants_spec',
    schema_version: '1.0',
    state_path: statePath,
    history_path: historyPath,
    invariants: [
      { id: 'contains', type: 'file_contains_all', path: textFile, patterns: ['alpha', 'gamma'] },
      { id: 'gte', type: 'json_path_gte', path: jsonFile, json_path: 'nested.count', value: 2 },
      { id: 'includes', type: 'json_path_includes', path: jsonFile, json_path: 'modes', value: 'b' },
      { id: 'equals', type: 'json_path_equals', path: jsonFile, json_path: 'enabled', value: true }
    ]
  });

  const env = { FORMAL_INVARIANT_SPEC_PATH: specPath };
  const passRun = run(['run', '--strict=1'], env);
  assert.strictEqual(passRun.status, 0, passRun.stderr || passRun.stdout);
  const passPayload = parseJson(passRun.stdout);
  assert.strictEqual(passPayload.ok, true);
  assert.strictEqual(Number(passPayload.failed_invariants || 0), 0);

  writeJson(specPath, {
    schema_id: 'formal_invariants_spec',
    schema_version: '1.0',
    state_path: statePath,
    history_path: historyPath,
    invariants: [
      { id: 'bad', type: 'json_path_gte', path: jsonFile, json_path: 'nested.count', value: 9 }
    ]
  });
  const failRun = run(['run', '--strict=1'], env);
  assert.notStrictEqual(failRun.status, 0, 'strict run must fail when invariant fails');
  const failPayload = parseJson(failRun.stdout);
  assert.strictEqual(failPayload.ok, false);
  assert.ok(Number(failPayload.failed_invariants || 0) >= 1);

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('formal_invariant_engine.test.js: OK');
} catch (err) {
  console.error(`formal_invariant_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

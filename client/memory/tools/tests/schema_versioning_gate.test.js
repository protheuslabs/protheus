#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'contracts', 'schema_versioning_gate.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-versioning-gate-'));
  const policyPath = path.join(tmp, 'config', 'schema_versioning_gate_policy.json');
  const targetPath = path.join(tmp, 'config', 'contracts', 'target.json');

  writeJson(targetPath, { schema_id: 'x_event', schema_version: '1.0', value: 1 });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    targets: [
      {
        id: 'x_event',
        path: targetPath,
        required_schema_id: 'x_event',
        min_schema_version: '1.0',
        kind: 'json'
      }
    ],
    outputs: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  const env = {
    SCHEMA_VERSIONING_GATE_ROOT: tmp,
    SCHEMA_VERSIONING_GATE_POLICY_PATH: policyPath
  };

  let r = run(['check', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'check should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');

  writeJson(targetPath, { schema_id: 'x_event' });
  r = run(['check', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'missing schema version should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail');

  r = run(['migrate', '--target=x_event', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'migration should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'migration payload should pass');

  r = run(['check', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'check should pass after migration');

  console.log('schema_versioning_gate.test.js: OK');
}

try { main(); } catch (err) { console.error(`schema_versioning_gate.test.js: FAIL: ${err.message}`); process.exit(1); }

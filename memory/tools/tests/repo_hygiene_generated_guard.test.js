#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'repo_hygiene_generated_guard.js');

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
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-hygiene-guard-'));
  const policyPath = path.join(tmp, 'config', 'repo_hygiene_generated_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'repo_hygiene_generated_guard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'repo_hygiene_generated_guard', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    blocked_globs: ['state/**', 'tmp/**'],
    allow_globs: ['state/README.md'],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    REPO_HYGIENE_GUARD_ROOT: tmp,
    REPO_HYGIENE_GUARD_POLICY_PATH: policyPath
  };

  let out = run([
    'check',
    '--strict=1',
    '--staged-file=systems/ops/new.ts',
    '--staged-file=state/runtime.json',
    '--staged-file=state/README.md'
  ], env);
  assert.strictEqual(out.status, 1, 'strict mode should fail on generated artifact violation');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'payload should fail');
  assert.strictEqual(Number(payload.violation_count || 0), 1, 'only non-allowlisted generated file should violate');

  out = run([
    'check',
    '--strict=0',
    '--staged-file=systems/ops/new.ts',
    '--staged-file=docs/readme.md'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict run should pass process');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'should pass when no blocked staged files');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('repo_hygiene_generated_guard.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`repo_hygiene_generated_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

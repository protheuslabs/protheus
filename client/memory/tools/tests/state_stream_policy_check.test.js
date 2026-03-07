#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'state_stream_policy_check.js');

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
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-stream-policy-'));
  const policyPath = path.join(tmp, 'config', 'state_stream_policy.json');
  const docsPath = path.join(tmp, 'docs', 'STATE_STREAM_POLICY.md');
  const gitignorePath = path.join(tmp, '.gitignore');
  const latestPath = path.join(tmp, 'state', 'ops', 'state_stream_policy_check', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'state_stream_policy_check', 'history.jsonl');

  write(docsPath, [
    '# State Stream Policy',
    '',
    'source_of_truth',
    'runtime_state',
    'skills_local',
    'client/systems/**',
    'state/**',
    'client/skills/**'
  ].join('\n'));

  write(gitignorePath, [
    'state/**',
    'tmp/',
    'client/logs/tool_raw/',
    '!client/memory/tools/**',
    '!client/skills/mcp/*.ts',
    '!client/skills/mcp/*.js',
    '!client/skills/mcp/*.json'
  ].join('\n'));

  writeJson(policyPath, {
    version: '1.0-test',
    docs_path: docsPath,
    gitignore_path: gitignorePath,
    state_classes: [
      { id: 'source_of_truth', mode: 'tracked', paths: ['client/systems/**'] },
      { id: 'runtime_state', mode: 'ignored', paths: ['state/**'] },
      { id: 'skills_local', mode: 'ignored', paths: ['client/skills/**'] }
    ],
    required_ignore_patterns: ['state/**', 'tmp/', 'client/logs/tool_raw/'],
    required_unignore_patterns: ['!client/memory/tools/**', '!client/skills/mcp/*.ts', '!client/skills/mcp/*.js', '!client/skills/mcp/*.json'],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    STATE_STREAM_POLICY_ROOT: tmp,
    STATE_STREAM_POLICY_PATH: policyPath
  };

  let out = run(['check', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'check should pass in strict mode');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'payload should be ok');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  write(gitignorePath, ['state/**'].join('\n'));
  out = run(['check', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict check should not hard fail process');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'payload should fail when alignment breaks');
  assert.ok(Array.isArray(payload.findings) && payload.findings.some((f) => String(f).includes('gitignore_missing_unignore')), 'should flag missing unignore');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('state_stream_policy_check.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`state_stream_policy_check.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

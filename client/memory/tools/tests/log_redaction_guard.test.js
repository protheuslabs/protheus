#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'log_redaction_guard.js');

function run(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected JSON output');
  return JSON.parse(txt);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-redaction-'));
  const targetDir = path.join(tmp, 'target');
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'policy.json');
  const logPath = path.join(targetDir, 'sample.log');
  fs.mkdirSync(targetDir, { recursive: true });

  const raw = [
    'Authorization: Bearer SUPER_SECRET_TOKEN_12345',
    '{"auth_token":"abc1234567890","note":"keep"}',
    'https://example.com/cb?ct0=abcdef12345&x=1'
  ].join('\n');
  fs.writeFileSync(logPath, raw, 'utf8');

  fs.writeFileSync(policyPath, JSON.stringify({
    version: '1.0',
    enabled: true,
    max_file_bytes: 1024 * 1024,
    include_extensions: ['.log'],
    target_paths: [targetDir],
    exclude_path_substrings: [],
    patterns: [
      {
        id: 'auth_bearer_header',
        regex: "Authorization:\\s*Bearer\\s+(?!\\[REDACTED\\])[^\\s\\\"']+",
        replace_with: 'Authorization: Bearer [REDACTED]'
      },
      {
        id: 'json_secret_fields',
        regex: '(\\\"(?:auth_token|access_token|refresh_token|api_key|secret|password)\\\"\\s*:\\s*)\\\"((?!\\[REDACTED\\])[^\\\"]+)\\\"',
        replace_with: '$1\"[REDACTED]\"'
      },
      {
        id: 'query_secret_fields',
        regex: '([?&](?:token|access_token|api_key|auth|ct0|bearer)=)(?!\\[REDACTED\\])[^&\\s]+',
        replace_with: '$1[REDACTED]'
      }
    ]
  }, null, 2), 'utf8');

  const env = {
    LOG_REDACTION_POLICY_PATH: policyPath,
    LOG_REDACTION_STATE_DIR: stateDir
  };

  let res = run(['run', '--apply=0', '--strict=0'], env);
  assert.strictEqual(res.status, 0, `dry-run failed: ${res.stderr}`);
  let out = parseJson(res.stdout);
  assert.ok(out.files_scanned >= 1, 'should scan at least one file');
  assert.ok(out.files_flagged >= 1, 'should flag sensitive matches');
  assert.strictEqual(out.files_redacted, 0, 'dry-run should not rewrite files');

  const stillRaw = fs.readFileSync(logPath, 'utf8');
  assert.ok(stillRaw.includes('SUPER_SECRET_TOKEN_12345'), 'dry-run should keep raw content');

  res = run(['run', '--apply=1', '--strict=0'], env);
  assert.strictEqual(res.status, 0, `apply run failed: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.ok(out.files_redacted >= 1, 'apply should redact at least one file');

  const redacted = fs.readFileSync(logPath, 'utf8');
  assert.ok(redacted.includes('Authorization: Bearer [REDACTED]'), 'authorization header should be redacted');
  assert.ok(redacted.includes('"auth_token":"[REDACTED]"'), 'json auth_token should be redacted');
  assert.ok(redacted.includes('ct0=[REDACTED]'), 'query token should be redacted');
  assert.ok(!redacted.includes('SUPER_SECRET_TOKEN_12345'), 'raw token should be removed');

  // scrub command should also succeed as a one-shot utility.
  res = run(['scrub'], env);
  assert.strictEqual(res.status, 0, `scrub command failed: ${res.stderr}`);

  // strict mode should pass now (no further matches)
  res = run(['run', '--apply=0', '--strict=1'], env);
  assert.strictEqual(res.status, 0, `strict check should pass after redaction: ${res.stdout} ${res.stderr}`);

  console.log('log_redaction_guard.test.js: OK');
}

main();

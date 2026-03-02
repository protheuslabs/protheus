#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'stale_state_cleanup.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function setMtime(filePath, iso) {
  const at = new Date(iso);
  fs.utimesSync(filePath, at, at);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-cleanup-'));
  const policyPath = path.join(tmp, 'config', 'stale_state_cleanup_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'cleanup', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'cleanup', 'history.jsonl');

  const oldFile = path.join(tmp, 'state', 'sensory', 'old.jsonl');
  const freshFile = path.join(tmp, 'state', 'sensory', 'fresh.jsonl');
  const excludedFile = path.join(tmp, 'state', 'security', 'keep.jsonl');
  write(oldFile, '{"old":true}\n');
  write(freshFile, '{"fresh":true}\n');
  write(excludedFile, '{"keep":true}\n');

  setMtime(oldFile, '2025-01-01T00:00:00.000Z');
  setMtime(freshFile, new Date().toISOString());
  setMtime(excludedFile, '2025-01-01T00:00:00.000Z');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_age_days: 30,
    roots: ['state'],
    allowed_suffixes: ['.jsonl'],
    exclude_prefixes: ['state/security'],
    dry_run_default: true,
    paths: {
      quarantine_dir: path.join(tmp, 'state', 'ops', 'cleanup', 'quarantine'),
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    STALE_STATE_CLEANUP_ROOT: tmp,
    STALE_STATE_CLEANUP_POLICY_PATH: policyPath
  };

  let out = run(['plan', '--max-age-days=30'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'plan should pass');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'plan payload should be ok');
  assert.strictEqual(Number(payload.candidate_count || 0), 1, 'only old non-excluded file should be candidate');
  assert.ok(fs.existsSync(oldFile), 'dry-run should not move old file');

  out = run(['plan', '--max-age-days=30', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'apply should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'apply payload should be ok');
  assert.strictEqual(Number(payload.moved_count || 0), 1, 'apply should move one file');
  assert.ok(!fs.existsSync(oldFile), 'old file should be moved');
  assert.ok(fs.existsSync(freshFile), 'fresh file should remain');
  assert.ok(fs.existsSync(excludedFile), 'excluded file should remain');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.latest && payload.latest.type === 'stale_state_cleanup', 'status should expose latest cleanup run');

  console.log('stale_state_cleanup.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`stale_state_cleanup.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

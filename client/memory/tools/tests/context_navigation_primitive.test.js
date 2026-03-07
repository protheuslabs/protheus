#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected JSON stdout');
  return JSON.parse(raw);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'context_navigation_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-nav-'));

  const policyPath = path.join(tmpRoot, 'config', 'context_navigation_primitive_policy.json');
  const latestPath = path.join(tmpRoot, 'state', 'assimilation', 'context_navigation', 'latest.json');
  const receiptsPath = path.join(tmpRoot, 'state', 'assimilation', 'context_navigation', 'receipts.jsonl');

  writeJson(policyPath, {
    schema_id: 'context_navigation_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    recursion: {
      max_depth: 3,
      max_segments_per_depth: 8,
      max_selected_segments: 12,
      min_relevance_score: 1
    },
    context: {
      max_chars_per_segment: 180,
      max_total_chars: 16000
    },
    state: {
      latest_path: latestPath,
      receipts_path: receiptsPath
    }
  });

  const env = {
    ...process.env,
    CONTEXT_NAVIGATION_POLICY_PATH: policyPath
  };

  const objective = 'extract payment retries and auth failure patterns for safer execution';
  const input = {
    objective,
    context_rows: [
      'payment gateway retries spiked during auth token refresh windows',
      'marketing copy review for spring launch',
      'auth failure patterns point to stale session cookies and timeout edges',
      'unrelated note about logo colors'
    ]
  };

  const runProc = runNode(scriptPath, [
    'run',
    `--input-json=${JSON.stringify(input)}`
  ], env, repoRoot);
  assert.strictEqual(runProc.status, 0, runProc.stderr || runProc.stdout);
  const out = parseJson(runProc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.type, 'context_navigation_primitive');
  assert.ok(Array.isArray(out.selected_segments));
  assert.ok(out.selected_segments.length >= 1, 'should keep relevant segments');
  assert.ok(out.executor_profile && out.executor_profile.schema_id === 'context_navigation_profile');
  assert.ok(Number(out.metrics.reduction_ratio || 0) >= 0, 'reduction ratio should be present');

  const statusProc = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const status = parseJson(statusProc);
  assert.strictEqual(status.ok, true);
  assert.ok(status.latest && status.latest.profile_id, 'status should expose latest profile');

  console.log('context_navigation_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`context_navigation_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

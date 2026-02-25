#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'skill_generation_pipeline.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeJsonl(p, rows) {
  mkDir(path.dirname(p));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(p, body + (body ? '\n' : ''), 'utf8');
}

function parsePayload(stdout) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch {}
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    payload: parsePayload(r.stdout)
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-generation-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'skill_generation');
  const date = '2026-02-25';

  writeJson(policyPath, {
    version: '1.0',
    min_pattern_attempts: 3,
    min_pattern_shipped: 2,
    min_estimated_savings_minutes: 20,
    max_candidates_per_run: 5,
    novelty_only_block_enabled: true,
    require_dual_approval: true
  });

  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    { ts: `${date}T00:00:00.000Z`, type: 'autonomy_run', proposal_type: 'external_intel', source_eye: 'eye_a', capability_key: 'proposal:external_intel', outcome: 'shipped' },
    { ts: `${date}T01:00:00.000Z`, type: 'autonomy_run', proposal_type: 'external_intel', source_eye: 'eye_a', capability_key: 'proposal:external_intel', outcome: 'shipped' },
    { ts: `${date}T02:00:00.000Z`, type: 'autonomy_run', proposal_type: 'external_intel', source_eye: 'eye_a', capability_key: 'proposal:external_intel', outcome: 'no_change' },
    { ts: `${date}T03:00:00.000Z`, type: 'autonomy_run', proposal_type: 'directive_decomposition', source_eye: 'eye_b', capability_key: 'proposal:directive_decomposition', outcome: 'no_change' }
  ]);

  const env = {
    SKILL_GENERATION_POLICY_PATH: policyPath,
    SKILL_GENERATION_RUNS_DIR: runsDir,
    SKILL_GENERATION_STATE_DIR: stateDir
  };

  try {
    let r = run(['run', date, '--days=1', '--apply=1'], env);
    assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.generated_count || 0) >= 1, 'expected generated candidate');
    assert.ok(fs.existsSync(path.join(stateDir, 'approval_queue.json')), 'approval queue should be written');

    const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'approval_queue.json'), 'utf8'));
    assert.ok(Array.isArray(queue.pending) && queue.pending.length >= 1, 'approval queue should have pending entry');

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.pending_approvals || 0) >= 1, 'status should show pending approvals');

    console.log('skill_generation_pipeline.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`skill_generation_pipeline.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-promote-'));
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'workflow_policy.json');
  const orchestronLatest = path.join(tmp, 'state', 'adaptive', 'workflows', 'orchestron', 'latest.json');

  writeJson(registryPath, {
    version: '1.0',
    updated_at: null,
    generated_at: null,
    workflows: []
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_pattern_occurrences: 2,
    min_shipped_rate: 0.1,
    max_drafts_per_run: 10,
    apply_threshold: 0.5,
    max_registry_workflows: 50
  });

  writeJson(orchestronLatest, {
    ok: true,
    type: 'orchestron_adaptive_run',
    policy: {
      shadow_only: true
    },
    red_team: {
      critical_fail_cases: 0
    },
    drafts: [],
    passing: [],
    promotable_drafts: [
      {
        id: 'wf_promote_1',
        name: 'Promote Candidate',
        status: 'draft',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: {
          score: 0.4,
          predicted_drift_delta: -0.002,
          predicted_yield_delta: 0.01,
          safety_score: 0.78,
          regression_risk: 0.22
        }
      }
    ]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    ORCHESTRON_LATEST_PATH: orchestronLatest
  };

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parsePayload(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(statusOut.orchestron_latest_exists, true, 'orchestron latest should exist');
  assert.strictEqual(statusOut.orchestron_shadow_only, true, 'shadow flag should be surfaced');
  assert.strictEqual(Number(statusOut.orchestron_promotable_drafts || 0), 1, 'status should expose promotable draft count');

  const promoteBlocked = spawnSync(process.execPath, [
    scriptPath,
    'promote',
    '--source=promotable',
    '--status=active',
    '--approver-id=test_runner',
    '--approval-note=promotion-test',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(promoteBlocked.status, 0, promoteBlocked.stderr || 'promote (threshold enforced) should pass');
  const blockedOut = parsePayload(promoteBlocked.stdout);
  assert.ok(blockedOut && blockedOut.ok === true, 'promote output should be ok');
  assert.strictEqual(Number(blockedOut.applied || 0), 0, 'should not apply when below threshold');

  const promoteForced = spawnSync(process.execPath, [
    scriptPath,
    'promote',
    '--source=promotable',
    '--status=active',
    '--ignore-threshold=1',
    '--approver-id=test_runner',
    '--approval-note=promotion-test',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(promoteForced.status, 0, promoteForced.stderr || 'promote (ignore threshold) should pass');
  const forcedOut = parsePayload(promoteForced.stdout);
  assert.ok(forcedOut && forcedOut.ok === true, 'forced promote output should be ok');
  assert.strictEqual(Number(forcedOut.applied || 0), 1, 'forced promote should apply one workflow');

  const listProc = spawnSync(process.execPath, [scriptPath, 'list', '--status=active', '--limit=5'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(listProc.status, 0, listProc.stderr || 'list should pass');
  const listOut = parsePayload(listProc.stdout);
  assert.ok(listOut && listOut.ok === true, 'list output should be ok');
  assert.strictEqual(Number(listOut.count || 0), 1, 'active list should include promoted workflow');
  assert.strictEqual(String(listOut.workflows[0].id || ''), 'wf_promote_1', 'promoted workflow id should match');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_promote.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_promote.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

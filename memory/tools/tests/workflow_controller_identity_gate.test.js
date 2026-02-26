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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-identity-'));
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'workflow_policy.json');
  const orchestronLatest = path.join(tmp, 'state', 'adaptive', 'workflows', 'orchestron', 'latest.json');

  writeJson(registryPath, {
    version: '1.0',
    workflows: [
      {
        id: 'wf_parent',
        name: 'Parent Workflow',
        status: 'active',
        objective_id: 'T1_make_jay_billionaire_v1',
        metadata: {
          value_currency: 'revenue'
        },
        updated_at: '2026-02-24T00:00:00.000Z'
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_pattern_occurrences: 2,
    min_shipped_rate: 0.1,
    max_drafts_per_run: 10,
    apply_threshold: 0.1,
    max_registry_workflows: 50
  });

  writeJson(orchestronLatest, {
    ok: true,
    type: 'orchestron_adaptive_run',
    date: '2026-02-25',
    policy: {
      shadow_only: false
    },
    promotable_drafts: [
      {
        id: 'wf_child_bad_currency',
        name: 'Child Workflow With Bad Currency',
        status: 'draft',
        objective_id: 'T1_make_jay_billionaire_v1',
        parent_workflow_id: 'wf_parent',
        trigger: {
          proposal_type: 'external_intel',
          min_occurrences: 2
        },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: {
          score: 0.8,
          predicted_drift_delta: -0.001,
          predicted_yield_delta: 0.01,
          safety_score: 0.8,
          regression_risk: 0.2
        },
        metadata: {
          value_currency: 'delivery'
        }
      }
    ]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    ORCHESTRON_LATEST_PATH: orchestronLatest
  };

  const promoteProc = spawnSync(process.execPath, [
    scriptPath,
    'promote',
    '--source=promotable',
    '--status=active',
    '--ignore-threshold=1',
    '--approver-id=test_runner',
    '--approval-note=identity-gate-test',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(promoteProc.status, 0, promoteProc.stderr || 'promote should pass');
  const out = parsePayload(promoteProc.stdout);
  assert.ok(out && out.ok === true, 'promote output should be ok');
  assert.strictEqual(Number(out.applied || 0), 0, 'identity gate should block incompatible child draft');
  assert.ok(Number(out.identity_blocked || 0) >= 1, 'identity gate should report blocked promotion');

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const activeRows = (registry.workflows || []).filter((row) => String(row.status || '') === 'active');
  assert.strictEqual(activeRows.length, 1, 'registry should keep only original active parent');
  assert.strictEqual(String(activeRows[0].id || ''), 'wf_parent', 'original parent should remain active');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_identity_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_identity_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-controller-promotion-gate-'));
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'workflow_policy.json');
  const orchestronLatest = path.join(tmp, 'state', 'adaptive', 'workflows', 'orchestron', 'latest.json');
  const promotionReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'promotion_receipts');

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
    apply_threshold: 0.1,
    max_registry_workflows: 50,
    promotion_gate: {
      enabled: true,
      require_contract_fields: true,
      require_non_regression: true,
      require_approval_receipt: true,
      require_gate_step: true,
      require_receipt_step: true,
      require_approver_id: true,
      require_approval_note: true,
      max_predicted_drift_delta: 0,
      min_predicted_yield_delta: 0,
      min_safety_score: 0.5,
      max_regression_risk: 0.56,
      max_red_team_critical_fail_cases: 0
    }
  });

  writeJson(orchestronLatest, {
    ok: true,
    type: 'orchestron_adaptive_run',
    date: '2026-02-26',
    policy: { shadow_only: false },
    red_team: { critical_fail_cases: 0 },
    promotable_drafts: [
      {
        id: 'wf_good',
        name: 'Good Candidate',
        status: 'draft',
        trigger: { proposal_type: 'external_intel', min_occurrences: 2 },
        steps: [
          { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=test' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' },
          { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl' }
        ],
        metrics: {
          score: 0.65,
          predicted_drift_delta: -0.003,
          predicted_yield_delta: 0.02,
          safety_score: 0.72,
          regression_risk: 0.24
        }
      },
      {
        id: 'wf_bad',
        name: 'Bad Candidate',
        status: 'draft',
        trigger: { proposal_type: 'publish_pipeline', min_occurrences: 2 },
        steps: [
          { id: 'execute', type: 'command', command: 'node systems/actuation/actuation_executor.js run --kind=publish --dry-run' },
          { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>' }
        ],
        metrics: {
          score: 0.66,
          predicted_drift_delta: 0.02,
          predicted_yield_delta: 0.01,
          safety_score: 0.61,
          regression_risk: 0.3
        }
      }
    ]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    ORCHESTRON_LATEST_PATH: orchestronLatest,
    WORKFLOW_PROMOTION_RECEIPTS_DIR: promotionReceiptsDir
  };

  const promote = spawnSync(process.execPath, [
    scriptPath,
    'promote',
    '--source=promotable',
    '--status=active',
    '--ignore-threshold=1',
    '--approver-id=test_runner',
    '--approval-note=promotion-gate-test',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(promote.status, 0, promote.stderr || 'promote command should pass');
  const out = parsePayload(promote.stdout);
  assert.ok(out && out.ok === true, 'promote output should be ok');
  assert.strictEqual(Number(out.selected || 0), 2, 'expected two selected drafts');
  assert.strictEqual(Number(out.promotion_gate_eligible || 0), 1, 'exactly one draft should pass promotion gate');
  assert.strictEqual(Number(out.promotion_gate_blocked || 0), 1, 'exactly one draft should be blocked');
  assert.strictEqual(Number(out.applied || 0), 1, 'one workflow should be applied');
  assert.ok(out.promotion_gate_blocked_by_reason && typeof out.promotion_gate_blocked_by_reason === 'object', 'blocked reason summary should exist');
  assert.ok(
    Number(out.promotion_gate_blocked_by_reason.contract_receipt_step_missing || 0) >= 1
      || Number(out.promotion_gate_blocked_by_reason.non_regression_predicted_drift_above_max || 0) >= 1,
    'blocked reason summary should include contract/non-regression gate reason'
  );
  assert.ok(String(out.promotion_receipt_path || '').includes('promotion_receipts/'), 'promotion receipt path should be reported');

  const receiptPath = path.join(root, String(out.promotion_receipt_path || ''));
  assert.ok(fs.existsSync(receiptPath), 'promotion receipt file should exist');

  const list = spawnSync(process.execPath, [
    scriptPath,
    'list',
    '--status=active',
    '--limit=5'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(list.status, 0, list.stderr || 'list should pass');
  const listOut = parsePayload(list.stdout);
  assert.ok(listOut && listOut.ok === true, 'list output should be ok');
  assert.strictEqual(Number(listOut.count || 0), 1, 'exactly one active workflow should be present');
  assert.strictEqual(String(listOut.workflows[0].id || ''), 'wf_good', 'only passing workflow should be promoted');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_controller_promotion_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_controller_promotion_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected json stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'global_molt_cycle.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-molt-cycle-'));

  const policyPath = path.join(tmp, 'config', 'global_molt_cycle_policy.json');
  const stateDir = path.join(tmp, 'state', 'ops', 'global_molt');
  const atrophyLatest = path.join(tmp, 'state', 'autonomy', 'organs', 'atrophy', 'latest.json');
  const pathwayState = path.join(tmp, 'state', 'autonomy', 'weaver', 'pathway_state.json');
  const assimilationLedger = path.join(tmp, 'state', 'assimilation', 'ledger.json');

  writeJson(atrophyLatest, {
    candidates: [
      { organ_id: 'continuum', reason: 'low_usefulness' },
      { organ_id: 'research', reason: 'stale_no_usage' }
    ]
  });
  writeJson(pathwayState, {
    dormant: [
      { metric_id: 'revenue', reason: 'dormant_14d' },
      { metric_id: 'beauty', reason: 'dormant_21d' }
    ]
  });
  writeJson(assimilationLedger, {
    capabilities: {
      'cap.external.alpha': {
        source_type: 'external_adapter',
        last_used_ts: new Date(Date.now() - (45 * 24 * 60 * 60 * 1000)).toISOString()
      }
    }
  });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    cycle_days: 30,
    veto_window_hours: 24,
    require_human_approval_for_apply: true,
    require_veto_window_elapsed: false,
    max_actions_per_plan: 20,
    sources: {
      organ_atrophy_latest_path: atrophyLatest,
      weaver_pathway_state_path: pathwayState,
      assimilation_ledger_path: assimilationLedger
    },
    limits: {
      max_organ_candidates: 5,
      max_pathway_candidates: 5,
      max_assimilation_candidates: 5,
      assimilation_stale_days: 30
    }
  });

  const env = {
    ...process.env,
    GLOBAL_MOLT_POLICY_PATH: policyPath,
    GLOBAL_MOLT_STATE_DIR: stateDir
  };

  const plan = runNode(scriptPath, ['plan'], env, repoRoot);
  assert.strictEqual(plan.status, 0, plan.stderr || plan.stdout);
  const planOut = parseJson(plan, 'plan');
  assert.strictEqual(planOut.ok, true);
  assert.ok(Number(planOut.action_count || 0) >= 3, 'plan should include multi-source actions');
  assert.ok(Array.isArray(planOut.actions));
  assert.ok(
    planOut.actions.some((row) => row.action_type === 'compress_organ_endpoint'),
    'organ atrophy action should be present'
  );
  assert.ok(
    planOut.actions.every((row) => row.rollback && row.rollback.command),
    'every action should include rollback command'
  );

  const applyDenied = runNode(scriptPath, [
    'apply',
    `--plan-id=${planOut.plan_id}`
  ], env, repoRoot);
  assert.notStrictEqual(applyDenied.status, 0, 'apply should require human approval');

  const veto = runNode(scriptPath, [
    'veto',
    `--plan-id=${planOut.plan_id}`,
    '--reason=test_veto'
  ], env, repoRoot);
  assert.strictEqual(veto.status, 0, veto.stderr || veto.stdout);
  const vetoOut = parseJson(veto, 'veto');
  assert.strictEqual(vetoOut.ok, true);
  assert.strictEqual(vetoOut.status, 'vetoed');

  const applyAfterVeto = runNode(scriptPath, [
    'apply',
    `--plan-id=${planOut.plan_id}`,
    '--human-approved=1'
  ], env, repoRoot);
  assert.notStrictEqual(applyAfterVeto.status, 0, 'vetoed plan must not apply');

  const plan2 = runNode(scriptPath, ['plan'], env, repoRoot);
  assert.strictEqual(plan2.status, 0, plan2.stderr || plan2.stdout);
  const plan2Out = parseJson(plan2, 'plan2');
  assert.strictEqual(plan2Out.ok, true);

  const apply = runNode(scriptPath, [
    'apply',
    `--plan-id=${plan2Out.plan_id}`,
    '--human-approved=1'
  ], env, repoRoot);
  assert.strictEqual(apply.status, 0, apply.stderr || apply.stdout);
  const applyOut = parseJson(apply, 'apply');
  assert.strictEqual(applyOut.ok, true);
  assert.strictEqual(applyOut.reversible, true);
  assert.ok(Number(applyOut.action_count || 0) >= 3);

  const receiptsPath = path.join(stateDir, 'applied_receipts.jsonl');
  assert.ok(fs.existsSync(receiptsPath), 'applied receipts should be written');
  const receipts = String(fs.readFileSync(receiptsPath, 'utf8') || '').split('\n').filter(Boolean);
  assert.ok(receipts.length >= 3, 'applied receipts should include reversible action rows');

  console.log('global_molt_cycle.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`global_molt_cycle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

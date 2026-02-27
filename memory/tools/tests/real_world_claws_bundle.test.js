#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function makeFakeExecutor(filePath) {
  writeFile(filePath, `#!/usr/bin/env node
'use strict';
function parseArgs(argv) {
  const out = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
let params = {};
try { params = JSON.parse(String(args.params || '{}')); } catch {}
const shouldFail = params && params.force_fail === true;
const out = {
  ok: !shouldFail,
  type: 'actuation_executor_run',
  dry_run: !!args['dry-run'],
  kind: String(args.kind || ''),
  params
};
process.stdout.write(JSON.stringify(out) + '\\n');
process.exit(shouldFail ? 1 : 0);
`);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'actuation', 'real_world_claws_bundle.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'real-world-claws-'));
  const policyPath = path.join(tmpRoot, 'config', 'real_world_claws_policy.json');
  const statePath = path.join(tmpRoot, 'state', 'real_world_claws_state.json');
  const receiptsPath = path.join(tmpRoot, 'state', 'real_world_claws_receipts.jsonl');
  const fakeExecutorPath = path.join(tmpRoot, 'fake_executor.js');

  makeFakeExecutor(fakeExecutorPath);

  writeJson(policyPath, {
    version: '1.0-test',
    shadow_only: true,
    approval_tiers: {
      low: { human_approval: false },
      medium: { human_approval: false },
      high: { human_approval: true },
      critical: { human_approval: true }
    },
    channels: {
      browser: { enabled: true, adapter: 'browser_action' },
      api: { enabled: true, adapter: 'api_request' },
      payments: { enabled: true, adapter: 'payment_action', always_human_approval: true },
      comms: { enabled: true, adapter: 'message_send' },
      files: { enabled: true, adapter: 'file_update' }
    },
    max_steps_per_plan: 8
  });

  const env = {
    ...process.env,
    REAL_WORLD_CLAWS_POLICY_PATH: policyPath,
    REAL_WORLD_CLAWS_STATE_PATH: statePath,
    REAL_WORLD_CLAWS_RECEIPTS_PATH: receiptsPath,
    REAL_WORLD_CLAWS_EXECUTOR_SCRIPT: fakeExecutorPath
  };

  const planned = runNode(scriptPath, [
    'plan',
    '--plan-id=unit_plan_a',
    '--plan-json={"objective":"close opportunity","risk":"medium","steps":[{"id":"api_step","channel":"api","action":"post","params":{"x":1}},{"id":"bad_step","channel":"unknown","action":"noop","params":{}},{"id":"comms_step","channel":"comms","action":"message","params":{"to":"x"}}]}'
  ], env, repoRoot);
  assert.strictEqual(planned.status, 0, planned.stderr || planned.stdout);
  const plannedOut = parseJson(planned, 'plan');
  assert.strictEqual(plannedOut.ok, true);
  assert.strictEqual(plannedOut.plan.plan_id, 'unit_plan_a');
  assert.deepStrictEqual(plannedOut.plan.blocked_channels, ['unknown']);
  assert.strictEqual(plannedOut.plan.steps.length, 2);

  const blockedShadow = runNode(scriptPath, [
    'execute',
    '--plan-id=unit_plan_a',
    '--apply=1',
    '--approver-id=ops_user',
    '--approval-note=approved'
  ], env, repoRoot);
  assert.notStrictEqual(blockedShadow.status, 0, 'shadow policy should block apply');
  const blockedShadowOut = parseJson(blockedShadow, 'execute_shadow_block');
  assert.strictEqual(blockedShadowOut.ok, false);
  assert.ok(
    (blockedShadowOut.execution.reasons || []).includes('shadow_only_mode'),
    'shadow-only reason should be recorded'
  );

  const executeShadow = runNode(scriptPath, [
    'execute',
    '--plan-id=unit_plan_a',
    '--apply=0'
  ], env, repoRoot);
  assert.strictEqual(executeShadow.status, 0, executeShadow.stderr || executeShadow.stdout);
  const executeShadowOut = parseJson(executeShadow, 'execute_shadow');
  assert.strictEqual(executeShadowOut.ok, true);
  assert.strictEqual(executeShadowOut.execution.success, true);
  assert.strictEqual(executeShadowOut.execution.step_outcomes.length, 2);

  // Enable live execution and verify payment approval gate.
  writeJson(policyPath, {
    version: '1.0-test-live',
    shadow_only: false,
    approval_tiers: {
      low: { human_approval: false },
      medium: { human_approval: false },
      high: { human_approval: true },
      critical: { human_approval: true }
    },
    channels: {
      browser: { enabled: true, adapter: 'browser_action' },
      api: { enabled: true, adapter: 'api_request' },
      payments: { enabled: true, adapter: 'payment_action', always_human_approval: true },
      comms: { enabled: true, adapter: 'message_send' },
      files: { enabled: true, adapter: 'file_update' }
    },
    max_steps_per_plan: 8
  });

  const planPayment = runNode(scriptPath, [
    'plan',
    '--plan-id=unit_plan_payment',
    '--plan-json={"objective":"pay invoice","risk":"low","steps":[{"id":"pay_step","channel":"payments","action":"payout","params":{"amount":100}}]}'
  ], env, repoRoot);
  assert.strictEqual(planPayment.status, 0, planPayment.stderr || planPayment.stdout);

  const blockedNoApproval = runNode(scriptPath, [
    'execute',
    '--plan-id=unit_plan_payment',
    '--apply=1'
  ], env, repoRoot);
  assert.notStrictEqual(blockedNoApproval.status, 0, 'payment should require approval');
  const blockedNoApprovalOut = parseJson(blockedNoApproval, 'execute_payment_block');
  assert.ok(
    (blockedNoApprovalOut.execution.reasons || []).includes('human_approval_required'),
    'payment plan should require human approval'
  );

  const executeApproved = runNode(scriptPath, [
    'execute',
    '--plan-id=unit_plan_payment',
    '--apply=1',
    '--approver-id=ops_user',
    '--approval-note=manual-check-passed'
  ], env, repoRoot);
  assert.strictEqual(executeApproved.status, 0, executeApproved.stderr || executeApproved.stdout);
  const executeApprovedOut = parseJson(executeApproved, 'execute_payment_ok');
  assert.strictEqual(executeApprovedOut.ok, true);
  assert.strictEqual(executeApprovedOut.execution.success, true);

  const status = runNode(scriptPath, ['status', '--plan-id=unit_plan_payment'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.plan.plan_id, 'unit_plan_payment');

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 5, 'receipts should be emitted for plan + execute operations');
}

run();

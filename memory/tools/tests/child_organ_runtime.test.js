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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function makeLaneScript(filePath, ok) {
  writeFile(filePath, `#!/usr/bin/env node
'use strict';
const out = { ok: ${ok ? 'true' : 'false'}, lane: 'test_lane' };
process.stdout.write(JSON.stringify(out) + '\\n');
process.exit(${ok ? 0 : 1});
`);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'child_organ_runtime.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'child-organ-runtime-'));
  const policyPath = path.join(tmpRoot, 'config', 'child_organ_runtime_policy.json');
  const statePath = path.join(tmpRoot, 'state', 'child_organ_runtime_state.json');
  const receiptsPath = path.join(tmpRoot, 'state', 'child_organ_runtime_receipts.jsonl');
  const laneOk = path.join(tmpRoot, 'lane_ok.js');
  const laneFail = path.join(tmpRoot, 'lane_fail.js');
  makeLaneScript(laneOk, true);
  makeLaneScript(laneFail, false);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    max_children: 8,
    default_ttl_hours: 4,
    max_ttl_hours: 24,
    resource_envelope: {
      token_cap_default: 200,
      token_cap_max: 1000,
      memory_mb_default: 256,
      memory_mb_max: 2048,
      cpu_threads_default: 1,
      cpu_threads_max: 8
    },
    lanes: {
      nursery: { enabled: true, script: laneOk, args: [] },
      redteam: { enabled: true, script: laneOk, args: [] },
      evolution: { enabled: true, script: laneOk, args: [] }
    },
    rollback: {
      require_receipts: true,
      rollback_reason_default: 'child_lane_failure'
    }
  });

  const env = {
    ...process.env,
    CHILD_ORGAN_RUNTIME_POLICY_PATH: policyPath,
    CHILD_ORGAN_RUNTIME_STATE_PATH: statePath,
    CHILD_ORGAN_RUNTIME_RECEIPTS_PATH: receiptsPath
  };

  const spawned = runNode(scriptPath, [
    'spawn',
    '--child-id=child_a',
    '--parent-id=parent_main',
    '--objective=bounded recursion',
    '--ttl-hours=12',
    '--token-cap=450',
    '--memory-mb=768',
    '--cpu-threads=3',
    '--contracts-json={"parent_contract_id":"pc_1","clearance_limit":"L2","inheritance_mode":"strict","rollback_required":true}'
  ], env, repoRoot);
  assert.strictEqual(spawned.status, 0, spawned.stderr || spawned.stdout);
  const spawnedOut = parseJson(spawned, 'spawn');
  assert.strictEqual(spawnedOut.ok, true);
  assert.strictEqual(spawnedOut.child.envelope.token_cap, 450);
  assert.strictEqual(spawnedOut.child.contracts.clearance_limit, 'l2');

  const blockedShadow = runNode(scriptPath, [
    'run',
    '--child-id=child_a',
    '--apply=1'
  ], env, repoRoot);
  assert.notStrictEqual(blockedShadow.status, 0, 'apply should be blocked while shadow_only=true');
  const blockedShadowOut = parseJson(blockedShadow, 'run_shadow_block');
  assert.ok((blockedShadowOut.run.reasons || []).includes('shadow_only_mode'));

  const runShadow = runNode(scriptPath, [
    'run',
    '--child-id=child_a',
    '--apply=0'
  ], env, repoRoot);
  assert.strictEqual(runShadow.status, 0, runShadow.stderr || runShadow.stdout);
  const runShadowOut = parseJson(runShadow, 'run_shadow');
  assert.strictEqual(runShadowOut.ok, true);
  assert.strictEqual(runShadowOut.run.lane_results.length, 3);
  assert.strictEqual(runShadowOut.child.status, 'active');

  // Force one lane failure and ensure deterministic rollback-pending state.
  writeJson(policyPath, {
    version: '1.0-test-fail',
    enabled: true,
    shadow_only: false,
    max_children: 8,
    default_ttl_hours: 4,
    max_ttl_hours: 24,
    resource_envelope: {
      token_cap_default: 200,
      token_cap_max: 1000,
      memory_mb_default: 256,
      memory_mb_max: 2048,
      cpu_threads_default: 1,
      cpu_threads_max: 8
    },
    lanes: {
      nursery: { enabled: true, script: laneOk, args: [] },
      redteam: { enabled: true, script: laneFail, args: [] },
      evolution: { enabled: true, script: laneOk, args: [] }
    },
    rollback: {
      require_receipts: true,
      rollback_reason_default: 'child_lane_failure'
    }
  });

  const runFailed = runNode(scriptPath, [
    'run',
    '--child-id=child_a',
    '--apply=1'
  ], env, repoRoot);
  assert.notStrictEqual(runFailed.status, 0, 'failing lane should fail run');
  const runFailedOut = parseJson(runFailed, 'run_failed');
  assert.strictEqual(runFailedOut.ok, false);
  assert.strictEqual(runFailedOut.child.status, 'rollback_pending');
  assert.ok(runFailedOut.run.rollback_receipt_id, 'rollback receipt id should be emitted');

  const rollback = runNode(scriptPath, [
    'rollback',
    '--child-id=child_a',
    '--reason=operator_reclaim'
  ], env, repoRoot);
  assert.strictEqual(rollback.status, 0, rollback.stderr || rollback.stdout);
  const rollbackOut = parseJson(rollback, 'rollback');
  assert.strictEqual(rollbackOut.ok, true);
  assert.strictEqual(rollbackOut.child.status, 'rolled_back');

  const status = runNode(scriptPath, ['status', '--child-id=child_a'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.child.rollback.reason, 'operator_reclaim');

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 4, 'expected receipts for spawn/run/rollback actions');
}

run();

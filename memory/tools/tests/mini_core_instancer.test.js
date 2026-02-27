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
  assert.ok(raw, `${label}: expected stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'fractal', 'mini_core_instancer.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-core-'));
  const policyPath = path.join(tmp, 'config', 'mini_core_instancer_policy.json');
  const statePath = path.join(tmp, 'state', 'fractal', 'mini_core_instancer', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'fractal', 'mini_core_instancer', 'receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_depth: 3,
    max_instances: 10,
    namespace_root: path.join(tmp, 'state', 'fractal', 'mini_core_instancer', 'namespaces'),
    envelopes: {
      token_cap_default: 300,
      token_cap_max: 2000,
      memory_mb_default: 256,
      memory_mb_max: 2048
    },
    governance: {
      inherited_clearance_default: 'L2',
      require_parent_contract: true
    }
  });

  const env = {
    ...process.env,
    MINI_CORE_POLICY_PATH: policyPath,
    MINI_CORE_STATE_PATH: statePath,
    MINI_CORE_RECEIPTS_PATH: receiptsPath
  };

  const rootInst = runNode(scriptPath, [
    'instantiate',
    '--instance-id=core_root'
  ], env, root);
  assert.strictEqual(rootInst.status, 0, rootInst.stderr || rootInst.stdout);
  const rootOut = parseJson(rootInst, 'instantiate_root');
  assert.strictEqual(rootOut.ok, true);
  assert.strictEqual(rootOut.record.depth, 1);

  const childInst = runNode(scriptPath, [
    'instantiate',
    '--instance-id=core_child',
    '--parent-instance-id=core_root',
    '--contracts-json={"parent_contract_id":"contract_a","inherited_clearance":"L2"}'
  ], env, root);
  assert.strictEqual(childInst.status, 0, childInst.stderr || childInst.stdout);
  const childOut = parseJson(childInst, 'instantiate_child');
  assert.strictEqual(childOut.ok, true);
  assert.strictEqual(childOut.record.depth, 2);
  assert.strictEqual(childOut.record.contracts.parent_contract_id, 'contract_a');

  const tick = runNode(scriptPath, ['tick', '--instance-id=core_child'], env, root);
  assert.strictEqual(tick.status, 0, tick.stderr || tick.stdout);
  const tickOut = parseJson(tick, 'tick');
  assert.strictEqual(tickOut.ok, true);
  assert.strictEqual(tickOut.governance.contract_id, 'contract_a');

  const rollback = runNode(scriptPath, [
    'rollback',
    '--instance-id=core_child',
    '--reason=policy_revert'
  ], env, root);
  assert.strictEqual(rollback.status, 0, rollback.stderr || rollback.stdout);
  const rollbackOut = parseJson(rollback, 'rollback');
  assert.strictEqual(rollbackOut.ok, true);
  assert.strictEqual(rollbackOut.record.status, 'rolled_back');

  const tickRolled = runNode(scriptPath, ['tick', '--instance-id=core_child'], env, root);
  assert.notStrictEqual(tickRolled.status, 0, 'rolled-back instance must not tick');

  const status = runNode(scriptPath, ['status'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.instances.core_root, 'root should remain tracked');
  assert.ok(statusOut.instances.core_child, 'child should remain tracked');

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 4, 'expected instantiate/tick/rollback receipts');
}

run();

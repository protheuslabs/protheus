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
  const bridgePolicyPath = path.join(tmp, 'config', 'sovereign_blockchain_bridge_policy.json');
  const bridgePrimePath = path.join(tmp, 'config', 'bridge_prime_profile.json');
  const bridgeTemplatePath = path.join(tmp, 'config', 'bridge_bootstrap_template.json');
  const bridgeProposalsPath = path.join(tmp, 'state', 'bridge', 'proposals.jsonl');
  const bridgeBindingsPath = path.join(tmp, 'state', 'bridge', 'bindings.jsonl');
  const bridgeLatestPath = path.join(tmp, 'state', 'bridge', 'latest.json');
  const bridgeStatePath = path.join(tmp, 'state', 'bridge', 'state.json');
  const bridgeReceiptsPath = path.join(tmp, 'state', 'bridge', 'receipts.jsonl');
  const bridgeGenomePath = path.join(tmp, 'state', 'bridge', 'genome_ledger.jsonl');

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
  writeJson(bridgePrimePath, {
    profile_id: 'bridge-prime-test',
    version: '1.0'
  });
  writeJson(bridgeTemplatePath, {
    template_id: 'wallet_birth_bootstrap_v1',
    version: '1.0'
  });
  writeJson(bridgePolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    dna: {
      prime_profile_path: bridgePrimePath,
      bootstrap_template_path: bridgeTemplatePath,
      genome_ledger_path: bridgeGenomePath,
      secret_template_id: 'wallet_dna_root_v1',
      kernel_live_key_forbidden: true
    },
    state: {
      state_path: bridgeStatePath,
      latest_path: bridgeLatestPath,
      proposals_path: bridgeProposalsPath,
      bindings_path: bridgeBindingsPath,
      receipts_path: bridgeReceiptsPath
    }
  });

  const env = {
    ...process.env,
    MINI_CORE_POLICY_PATH: policyPath,
    MINI_CORE_STATE_PATH: statePath,
    MINI_CORE_RECEIPTS_PATH: receiptsPath,
    SOVEREIGN_BLOCKCHAIN_BRIDGE_POLICY_PATH: bridgePolicyPath
  };

  const rootInst = runNode(scriptPath, [
    'instantiate',
    '--instance-id=core_root'
  ], env, root);
  assert.strictEqual(rootInst.status, 0, rootInst.stderr || rootInst.stdout);
  const rootOut = parseJson(rootInst, 'instantiate_root');
  assert.strictEqual(rootOut.ok, true);
  assert.strictEqual(rootOut.record.depth, 1);
  assert.ok(rootOut.verification && rootOut.verification.pass === true, 'root instantiate should include containment verification');
  assert.ok(rootOut.rollback_readiness && rootOut.rollback_readiness.rollback_ready === true, 'root instantiate should include rollback readiness');
  assert.ok(rootOut.wallet_bootstrap_bridge && rootOut.wallet_bootstrap_bridge.ok === true, 'instantiate root should enqueue wallet bridge proposal');
  assert.strictEqual(String(rootOut.wallet_bootstrap_bridge.stage || ''), 'shadow_proposed', 'wallet bridge should remain shadow');

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
  assert.ok(childOut.verification && childOut.verification.pass === true, 'child instantiate should include containment verification');
  assert.ok(childOut.rollback_readiness && childOut.rollback_readiness.rollback_ready === true, 'child instantiate should include rollback readiness');
  assert.ok(childOut.wallet_bootstrap_bridge && childOut.wallet_bootstrap_bridge.ok === true, 'instantiate child should enqueue wallet bridge proposal');

  const tick = runNode(scriptPath, ['tick', '--instance-id=core_child'], env, root);
  assert.strictEqual(tick.status, 0, tick.stderr || tick.stdout);
  const tickOut = parseJson(tick, 'tick');
  assert.strictEqual(tickOut.ok, true);
  assert.strictEqual(tickOut.governance.contract_id, 'contract_a');
  assert.ok(tickOut.verification && tickOut.verification.pass === true, 'tick should include containment verification');
  assert.ok(tickOut.rollback_readiness && tickOut.rollback_readiness.rollback_ready === true, 'tick should include rollback readiness');

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
  assert.ok(statusOut.summary && Number(statusOut.summary.active_instances || 0) >= 1, 'status should include summary counts');
  assert.ok(Number(statusOut.summary.rollback_ready_instances || 0) >= 1, 'status should expose rollback-ready instance count');

  const receipts = fs.existsSync(receiptsPath)
    ? fs.readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(receipts.length >= 4, 'expected instantiate/tick/rollback receipts');
  assert.ok(fs.existsSync(bridgeProposalsPath), 'bridge proposals should be written');
  const bridgeRows = fs.readFileSync(bridgeProposalsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(bridgeRows.some((row) => String(row.birth_context || '') === 'mini_core_instantiate' && String(row.instance_id || '') === 'core_root'), 'root instance should emit bridge proposal');
  assert.ok(bridgeRows.some((row) => String(row.birth_context || '') === 'mini_core_instantiate' && String(row.instance_id || '') === 'core_child'), 'child instance should emit bridge proposal');
}

run();

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
  const scriptPath = path.join(repoRoot, 'systems', 'assimilation', 'group_evolving_agents_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-evo-'));

  const policyPath = path.join(tmpRoot, 'config', 'group_evolving_agents_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'assimilation', 'group_evolving_agents');

  writeJson(policyPath, {
    schema_id: 'group_evolving_agents_primitive_policy',
    schema_version: '1.0-test',
    enabled: true,
    shadow_only: true,
    sharing: {
      max_peer_experiences: 20,
      min_reuse_confidence: 0.5,
      innovation_bonus: 0.2
    },
    trust: {
      min_peer_trust: 0.3,
      trust_decay: 0.95,
      trust_gain: 0.05,
      trust_penalty: 0.1
    },
    federation: {
      enabled: true,
      opt_in_required: true,
      local_instance_id: 'local_test_node',
      max_export_capabilities: 32,
      max_import_capabilities: 64,
      min_attestation_score: 0.5,
      import_trust_gain: 0.03,
      import_trust_penalty: 0.05,
      archive_dir: path.join(stateDir, 'federation')
    },
    state: {
      pool_path: path.join(stateDir, 'pool.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    GROUP_EVOLVING_AGENTS_POLICY_PATH: policyPath
  };

  const input = {
    capability_id: 'cap.alpha',
    agent_id: 'agent.main',
    experiences: [
      {
        peer_id: 'peer.one',
        innovation_id: 'innovation.retry_window',
        confidence: 0.9,
        adopted: true,
        outcome: 'success'
      },
      {
        peer_id: 'peer.two',
        innovation_id: 'innovation.passport_chain',
        confidence: 0.8,
        adopted: false,
        outcome: 'shadow_only'
      },
      {
        peer_id: 'peer.three',
        innovation_id: 'innovation.low_confidence',
        confidence: 0.2,
        adopted: false,
        outcome: 'reject'
      }
    ]
  };

  const run1 = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(input)}`], env, repoRoot);
  assert.strictEqual(run1.status, 0, run1.stderr || run1.stdout);
  const out1 = parseJson(run1);
  assert.strictEqual(out1.ok, true);
  assert.strictEqual(out1.capability_id, 'cap.alpha');
  assert.ok(Number(out1.accepted_experience_count || 0) >= 2, 'expected accepted peer experiences');
  assert.ok(Number(out1.group_advantage_score || 0) > 0, 'expected positive group advantage score');

  const run2 = runNode(scriptPath, ['run', `--input-json=${JSON.stringify(input)}`], env, repoRoot);
  assert.strictEqual(run2.status, 0, run2.stderr || run2.stdout);
  const out2 = parseJson(run2);
  assert.strictEqual(out2.ok, true);
  assert.ok(Number(out2.innovation_reuse_count || 0) >= 1, 'expected innovation reuse count');

  const status = runNode(scriptPath, ['status', '--capability-id=cap.alpha'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(statusOut.capability_state, 'status should include capability state');
  assert.ok(statusOut.federation && statusOut.federation.enabled === true, 'status should include federation summary');

  const exported = runNode(scriptPath, [
    'export-archive',
    '--opt-in=1',
    '--peer-id=peer.federated',
    '--attestation-score=0.92'
  ], env, repoRoot);
  assert.strictEqual(exported.status, 0, exported.stderr || exported.stdout);
  const exportedOut = parseJson(exported);
  assert.strictEqual(exportedOut.ok, true, 'export archive should pass');
  const exportedPath = path.join(repoRoot, exportedOut.package_path);
  assert.ok(fs.existsSync(exportedPath), 'export archive file should exist');

  const importPath = path.join(tmpRoot, 'incoming_exchange.json');
  writeJson(importPath, {
    schema_id: 'group_evolving_agents_exchange',
    schema_version: '1.0',
    exported_at: new Date().toISOString(),
    source_instance_id: 'peer_cluster_a',
    peer_id: 'peer_cluster_a',
    attestation_score: 0.91,
    capabilities: {
      'cap.beta': {
        innovations: {
          'innovation.fast_path': {
            score: 2.4,
            confidence: 0.83,
            uses: 4,
            peer_id: 'peer_cluster_a'
          }
        },
        reuse_count: 1,
        total_observations: 1
      }
    }
  });

  const imported = runNode(scriptPath, [
    'import-archive',
    `--file=${importPath}`,
    '--opt-in=1'
  ], env, repoRoot);
  assert.strictEqual(imported.status, 0, imported.stderr || imported.stdout);
  const importedOut = parseJson(imported);
  assert.strictEqual(importedOut.ok, true, 'import archive should pass');
  assert.ok(Number(importedOut.imported_capability_count || 0) >= 1, 'import should include capabilities');
  assert.ok(Number(importedOut.imported_innovation_count || 0) >= 1, 'import should include innovations');

  console.log('group_evolving_agents_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`group_evolving_agents_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

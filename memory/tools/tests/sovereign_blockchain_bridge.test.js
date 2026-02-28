#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'blockchain', 'sovereign_blockchain_bridge.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-blockchain-bridge-'));
  const policyPath = path.join(tmp, 'policy.json');
  const primePath = path.join(tmp, 'protheus_prime_profile.json');
  const templatePath = path.join(tmp, 'bootstrap_wallet_proposal_template.json');
  const statePath = path.join(tmp, 'state.json');
  const latestPath = path.join(tmp, 'latest.json');
  const proposalsPath = path.join(tmp, 'proposals.jsonl');
  const bindingsPath = path.join(tmp, 'bindings.jsonl');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const genomePath = path.join(tmp, 'genome_ledger.jsonl');

  writeJson(primePath, {
    profile_id: 'protheus-prime-test',
    version: '1.0',
    wallet_dna: {
      enabled: true,
      mode: 'initialize_on_birth',
      kernel_live_key_forbidden: true,
      secret_template_id: 'wallet_dna_root_v1'
    }
  });

  writeJson(templatePath, {
    template_id: 'wallet_birth_bootstrap_v1',
    version: '1.0',
    required_gates: ['eye_kernel', 'constitution', 'soul_token'],
    forbidden_outputs: ['raw_private_key', 'seed_phrase', 'mnemonic']
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    wallet_mode: 'initialize_on_birth',
    dna: {
      prime_profile_path: primePath,
      bootstrap_template_path: templatePath,
      genome_ledger_path: genomePath,
      secret_template_id: 'wallet_dna_root_v1',
      kernel_live_key_forbidden: true
    },
    governance: {
      require_constitution_approval: true,
      require_soul_token_approval: true,
      require_eye_proposal: true,
      min_approval_note_chars: 12
    },
    chains: {
      ethereum_primary: { enabled: true, network: 'base', account_model: 'erc4337', paymaster_ready: true },
      solana_secondary: { enabled: true, optional: true, account_model: 'derived_keypair' }
    },
    identity_binding: {
      require_sbt_binding: true,
      require_erc8004_registration: true,
      require_helix_binding_hash: true
    },
    payments: {
      x402_enabled: true,
      storm_lane: 'storm_value_distribution',
      burn_oracle_source: path.join(tmp, 'burn_oracle_latest.json')
    },
    state: {
      state_path: statePath,
      latest_path: latestPath,
      proposals_path: proposalsPath,
      bindings_path: bindingsPath,
      receipts_path: receiptsPath
    }
  });

  const env = {
    SOVEREIGN_BLOCKCHAIN_BRIDGE_POLICY_PATH: policyPath
  };

  let proc = run(['status'], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'status should pass');
  let out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'status payload should be ok');
  assert.ok(out.kernel_wallet_material_guard && out.kernel_wallet_material_guard.ok === true, 'kernel wallet material guard should pass');

  proc = run(['bootstrap-proposal'], env);
  assert.strictEqual(proc.status, 1, 'missing instance id should fail');
  out = parseJson(proc.stdout);
  assert.strictEqual(String(out && out.error || ''), 'instance_id_required', 'error should require instance id');

  proc = run([
    'bootstrap-proposal',
    '--instance-id=phone_seed_a',
    '--birth-context=bootstrap',
    '--approval-note=initial governed wallet bootstrap approval',
    '--constitution-approved=1',
    '--soul-approved=1',
    '--apply=1'
  ], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'bootstrap proposal should pass in shadow');
  out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'bootstrap output should be ok');
  assert.strictEqual(String(out.stage || ''), 'shadow_blocked_apply', 'shadow mode should block apply');
  assert.strictEqual(Boolean(out.wallet_plan && out.wallet_plan.key_material_in_kernel), false, 'wallet plan must never expose key material in kernel');
  assert.ok(out.wallet_plan && out.wallet_plan.ethereum_primary, 'ethereum descriptor should be present');
  assert.ok(out.wallet_plan && out.wallet_plan.solana_secondary, 'solana descriptor should be present');
  const proposalId = String(out.proposal_id || '');
  assert.ok(proposalId, 'proposal id missing');

  proc = run([
    'bind-identity',
    `--proposal-id=${proposalId}`,
    '--sbt-token-id=sbt_test_1',
    '--erc8004-agent-id=agent_test_1',
    '--approval-note=bind identity attestations in shadow',
    '--constitution-approved=1',
    '--soul-approved=1',
    '--apply=1'
  ], env);
  assert.strictEqual(proc.status, 0, proc.stderr || 'bind identity should pass in shadow');
  out = parseJson(proc.stdout);
  assert.ok(out && out.ok === true, 'bind output should be ok');
  assert.strictEqual(String(out.stage || ''), 'shadow_binding_intent', 'shadow bind should stay intent-only');
  assert.ok(out.binding && String(out.binding.helix_binding_hash || '').length === 64, 'helix binding hash should be emitted');

  assert.ok(fs.existsSync(statePath), 'state file missing');
  assert.ok(fs.existsSync(latestPath), 'latest file missing');
  assert.ok(fs.existsSync(proposalsPath), 'proposals file missing');
  assert.ok(fs.existsSync(bindingsPath), 'bindings file missing');
  assert.ok(fs.existsSync(receiptsPath), 'receipts file missing');
  assert.ok(fs.existsSync(genomePath), 'genome ledger file missing');

  console.log('sovereign_blockchain_bridge.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`sovereign_blockchain_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

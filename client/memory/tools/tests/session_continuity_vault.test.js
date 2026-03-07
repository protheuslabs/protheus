#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  let payload = null;
  try {
    payload = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0]);
  } catch {}
  return {
    status: r.status ?? 0,
    payload,
    stderr: String(r.stderr || ''),
    stdout: String(r.stdout || '')
  };
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const activeBridge = path.join(repoRoot, 'systems', 'continuity', 'active_state_bridge.js');
  const vaultScript = path.join(repoRoot, 'systems', 'continuity', 'session_continuity_vault.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-vault-'));
  const root = path.join(tmp, 'workspace');
  const continuityState = path.join(root, 'state', 'continuity');
  mkdirp(root);

  writeJson(path.join(root, 'state', 'autonomy', 'cooldowns.json'), { lane: 'steady', token: 'redact-me' });
  writeJson(path.join(root, 'state', 'routing', 'route_state.json'), { selected_model: 'left_brain' });
  writeJson(path.join(root, 'state', 'spawn', 'allocations.json'), { slots: 2 });
  writeJson(path.join(root, 'state', 'adaptive', 'strategy', 'outcome_fitness.json'), { pass_rate: 0.5 });
  writeJson(path.join(root, 'state', 'sensory', 'eyes', 'registry.json'), { eyes: ['a'] });

  const policyPath = path.join(tmp, 'config', 'session_continuity_vault_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    auto_archive_on_checkpoint: true,
    key_env: 'SESSION_CONTINUITY_VAULT_KEY',
    key_min_length: 16,
    source: {
      checkpoint_dir: path.join(continuityState, 'checkpoints'),
      index_path: path.join(continuityState, 'checkpoints', 'index.json')
    },
    state: {
      root: path.join(continuityState, 'vault'),
      checkpoint_dir: path.join(continuityState, 'vault', 'checkpoints'),
      index_path: path.join(continuityState, 'vault', 'index.json'),
      latest_path: path.join(continuityState, 'vault', 'latest.json'),
      receipts_path: path.join(continuityState, 'vault', 'receipts.jsonl'),
      recovery_dir: path.join(continuityState, 'vault', 'recovery')
    }
  });

  const env = {
    CONTINUITY_ROOT: root,
    CONTINUITY_STATE_DIR: continuityState,
    CONTINUITY_VAULT_AUTO_ARCHIVE: '0',
    SESSION_CONTINUITY_VAULT_POLICY_PATH: policyPath,
    SESSION_CONTINUITY_VAULT_KEY: 'continuity-vault-test-key'
  };

  let r = runNode(activeBridge, ['acquire', '--writer=testA', '--ttl-sec=120'], env, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);

  r = runNode(activeBridge, ['checkpoint', '--writer=testA', '--label=vault-test'], env, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);
  const checkpointId = r.payload.checkpoint_id;
  assert.ok(checkpointId, 'checkpoint id required');

  r = runNode(vaultScript, ['archive', '--writer=testA', `--checkpoint=${checkpointId}`], env, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);
  const vaultId = r.payload.vault_id;
  assert.ok(vaultId, 'vault id required');

  writeJson(path.join(root, 'state', 'routing', 'route_state.json'), { selected_model: 'drifted_model' });
  const before = JSON.parse(fs.readFileSync(path.join(root, 'state', 'routing', 'route_state.json'), 'utf8'));
  assert.strictEqual(before.selected_model, 'drifted_model');

  r = runNode(vaultScript, ['restore', '--writer=testA', `--vault-id=${vaultId}`], env, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);

  const after = JSON.parse(fs.readFileSync(path.join(root, 'state', 'routing', 'route_state.json'), 'utf8'));
  assert.strictEqual(after.selected_model, 'left_brain', 'restore should recover checkpoint value');

  r = runNode(vaultScript, ['verify', `--vault-id=${vaultId}`], env, repoRoot);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.payload && r.payload.ok, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('session_continuity_vault.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`session_continuity_vault.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


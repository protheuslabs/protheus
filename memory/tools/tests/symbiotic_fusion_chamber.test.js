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
  const scriptPath = path.join(root, 'systems', 'fractal', 'symbiotic_fusion_chamber.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-chamber-'));
  const policyPath = path.join(tmp, 'config', 'symbiotic_fusion_chamber_policy.json');
  const statePath = path.join(tmp, 'state', 'fractal', 'symbiotic_fusion_chamber', 'state.json');
  const receiptsPath = path.join(tmp, 'state', 'fractal', 'symbiotic_fusion_chamber', 'receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    max_active_fusions: 8,
    default_ttl_hours: 6,
    max_ttl_hours: 48,
    min_members: 2,
    max_members: 6,
    require_policy_approval: true
  });

  const env = {
    ...process.env,
    SYMBIOTIC_FUSION_POLICY_PATH: policyPath,
    SYMBIOTIC_FUSION_STATE_PATH: statePath,
    SYMBIOTIC_FUSION_RECEIPTS_PATH: receiptsPath
  };

  const blocked = runNode(scriptPath, [
    'form',
    '--fusion-id=fusion_a',
    '--members-json=["mirror","weaver"]',
    '--ttl-hours=12',
    '--apply=1'
  ], env, root);
  assert.notStrictEqual(blocked.status, 0, 'policy approval should be required');
  const blockedOut = parseJson(blocked, 'form_blocked');
  assert.strictEqual(blockedOut.ok, false);
  assert.ok(blockedOut.blocked.includes('policy_approval_required'));

  const formed = runNode(scriptPath, [
    'form',
    '--fusion-id=fusion_a',
    '--members-json=["mirror","weaver"]',
    '--ttl-hours=12',
    '--policy-approval=1',
    '--apply=1'
  ], env, root);
  assert.strictEqual(formed.status, 0, formed.stderr || formed.stdout);
  const formedOut = parseJson(formed, 'form_ok');
  assert.strictEqual(formedOut.ok, true);
  assert.strictEqual(formedOut.record.status, 'active');

  const status = runNode(scriptPath, ['status'], env, root);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(Number(statusOut.counts.active || 0), 1);

  const dissolved = runNode(scriptPath, [
    'dissolve',
    '--fusion-id=fusion_a',
    '--reason=lease_complete'
  ], env, root);
  assert.strictEqual(dissolved.status, 0, dissolved.stderr || dissolved.stdout);
  const dissolvedOut = parseJson(dissolved, 'dissolve');
  assert.strictEqual(dissolvedOut.ok, true);
  assert.strictEqual(dissolvedOut.record.status, 'dissolved');

  assert.ok(fs.existsSync(receiptsPath), 'fusion receipts should exist');
}

run();

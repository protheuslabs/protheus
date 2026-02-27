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
  const scriptPath = path.join(root, 'systems', 'forge', 'forge_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-organ-'));
  const policyPath = path.join(tmp, 'config', 'forge_organ_policy.json');
  const statePath = path.join(tmp, 'state', 'autonomy', 'forge_organ', 'state.json');
  const runsPath = path.join(tmp, 'state', 'autonomy', 'forge_organ', 'runs', '2026-02-26.jsonl');
  const promotionsPath = path.join(tmp, 'state', 'autonomy', 'forge_organ', 'promotions', '2026-02-26.jsonl');
  const latestPath = path.join(tmp, 'state', 'autonomy', 'forge_organ', 'latest.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    max_active_forged_organs: 10,
    default_ttl_hours: 12,
    max_ttl_hours: 48,
    containment: {
      sandbox_profile: 'strict_isolated',
      require_nursery_pass_for_promotion: true,
      require_policy_approval_for_promotion: true
    },
    hardware_classes: {
      tiny: ['io_bridge'],
      small: ['io_bridge', 'parser'],
      medium: ['io_bridge', 'parser', 'planner'],
      large: ['io_bridge', 'parser', 'planner', 'research_assist']
    }
  });

  const env = {
    ...process.env,
    FORGE_ORGAN_POLICY_PATH: policyPath,
    FORGE_ORGAN_STATE_PATH: statePath,
    FORGE_ORGAN_RUNS_PATH: runsPath,
    FORGE_ORGAN_PROMOTIONS_PATH: promotionsPath,
    FORGE_ORGAN_LATEST_PATH: latestPath
  };

  const forged = runNode(scriptPath, [
    'run',
    '--capability-id=capability_gap_parser',
    '--hardware-class=medium',
    '--ttl-hours=18',
    '--risk-class=general',
    '--mode=shadow'
  ], env, root);
  assert.strictEqual(forged.status, 0, forged.stderr || forged.stdout);
  const forgedOut = parseJson(forged, 'run');
  assert.strictEqual(forgedOut.ok, true);
  const forgeId = forgedOut.record.forge_id;
  assert.ok(forgeId, 'forge_id should be emitted');
  assert.ok(Array.isArray(forgedOut.record.capability_packs), 'hardware packs should resolve');

  const statusOne = runNode(scriptPath, ['status', `--forge-id=${forgeId}`], env, root);
  assert.strictEqual(statusOne.status, 0, statusOne.stderr || statusOne.stdout);
  const statusOut = parseJson(statusOne, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.strictEqual(statusOut.record.forge_id, forgeId);

  const promoteBlocked = runNode(scriptPath, ['promote', `--forge-id=${forgeId}`], env, root);
  assert.notStrictEqual(promoteBlocked.status, 0, 'promotion should be blocked without approvals');
  const promoteBlockedOut = parseJson(promoteBlocked, 'promote_blocked');
  assert.strictEqual(promoteBlockedOut.ok, false);
  assert.ok(promoteBlockedOut.promotion.blocked.includes('nursery_pass_required'));
  assert.ok(promoteBlockedOut.promotion.blocked.includes('policy_approval_required'));

  const promoteOk = runNode(scriptPath, [
    'promote',
    `--forge-id=${forgeId}`,
    '--nursery-pass=1',
    '--policy-approval=1'
  ], env, root);
  assert.strictEqual(promoteOk.status, 0, promoteOk.stderr || promoteOk.stdout);
  const promoteOkOut = parseJson(promoteOk, 'promote_ok');
  assert.strictEqual(promoteOkOut.ok, true);
  assert.strictEqual(promoteOkOut.promotion.decision, 'promote');

  const dissolved = runNode(scriptPath, [
    'dissolve',
    `--forge-id=${forgeId}`,
    '--reason=ttl_expired'
  ], env, root);
  assert.strictEqual(dissolved.status, 0, dissolved.stderr || dissolved.stdout);
  const dissolvedOut = parseJson(dissolved, 'dissolve');
  assert.strictEqual(dissolvedOut.ok, true);

  const finalStatus = runNode(scriptPath, ['status', `--forge-id=${forgeId}`], env, root);
  assert.strictEqual(finalStatus.status, 0, finalStatus.stderr || finalStatus.stdout);
  const finalStatusOut = parseJson(finalStatus, 'final_status');
  assert.strictEqual(finalStatusOut.record, null, 'dissolved organ should not remain active');

  assert.ok(fs.existsSync(runsPath), 'forge runs log should exist');
  assert.ok(fs.existsSync(promotionsPath), 'forge promotions log should exist');
}

run();

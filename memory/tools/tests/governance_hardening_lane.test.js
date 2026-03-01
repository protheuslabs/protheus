#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'governance_hardening_lane.js');

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-hardening-'));
  const policyPath = path.join(tmp, 'policy.json');
  const burnPath = path.join(tmp, 'burn_latest.json');
  const stateRoot = path.join(tmp, 'state');

  writeJson(burnPath, { cost_pressure: 'high' });
  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      state_root: stateRoot,
      actors_path: path.join(stateRoot, 'actors.json'),
      policy_chain_path: path.join(stateRoot, 'policy_chain.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl'),
      burn_latest_path: burnPath
    }
  });

  let res = run(['evaluate', `--policy=${policyPath}`, '--actor=test_actor', '--evasion=0', '--chains=0', '--anomaly=0', '--apply=1']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'evaluate should pass');
  assert.ok(res.payload.trust_tier, 'trust tier present');

  const parentPolicy = path.join(tmp, 'parent_policy.json');
  writeJson(parentPolicy, { k: 'v' });
  res = run(['bootstrap-child', `--policy=${policyPath}`, '--child=child_a', `--parent-policy=${parentPolicy}`, '--parent-signature=sig123']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'bootstrap child should pass');

  res = run(['verify-child', `--policy=${policyPath}`, '--child=child_a']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.payload && res.payload.ok === true, 'verify child should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('governance_hardening_lane.test.js: OK');
} catch (err) {
  console.error(`governance_hardening_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'redteam', 'ant_colony_controller.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-ant-colony-'));
  const policyPath = path.join(tmp, 'config', 'red_team_policy.json');
  const stateRoot = path.join(tmp, 'state', 'security', 'red_team');
  const helixRoot = path.join(tmp, 'state', 'helix');
  const soulRoot = path.join(tmp, 'state', 'security');
  const assimilationRoot = path.join(tmp, 'state', 'assimilation');

  const nowIso = new Date().toISOString();
  writeJson(path.join(assimilationRoot, 'ledger.json'), {
    version: '1.0',
    capabilities: {
      test_capability: {
        status: 'assimilated_ttl',
        last_assimilation_ts: nowIso
      }
    }
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    state_root: stateRoot,
    ant_colony: {
      enabled: true,
      shadow_only: true,
      paths: {
        helix_latest_path: path.join(helixRoot, 'latest.json'),
        helix_sentinel_state_path: path.join(helixRoot, 'sentinel_state.json'),
        soul_token_state_path: path.join(soulRoot, 'soul_token_guard.json'),
        assimilation_ledger_path: path.join(assimilationRoot, 'ledger.json')
      }
    }
  });

  writeJson(path.join(helixRoot, 'latest.json'), {
    verifier: { mismatch_count: 0 },
    attestation_decision: 'allow',
    sentinel: { tier: 'observe' }
  });
  writeJson(path.join(helixRoot, 'sentinel_state.json'), {
    current_tier: 'observe'
  });
  writeJson(path.join(soulRoot, 'soul_token_guard.json'), {
    fingerprint: 'test'
  });

  let res = run(['run', '2026-02-26', `--policy=${policyPath}`, '--red-confidence=0.22', '--executed-cases=2', '--fail-cases=0']);
  assert.strictEqual(res.status, 0, `peacetime run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'peacetime payload should be ok');
  assert.strictEqual(String(res.payload.mode || ''), 'peacetime', 'mode should start in peacetime');
  assert.strictEqual(Number(res.payload.priority_targets_count || 0), 1, 'priority target should include recent assimilation graft');

  writeJson(path.join(helixRoot, 'latest.json'), {
    verifier: { mismatch_count: 2 },
    attestation_decision: 'deny',
    sentinel: { tier: 'stasis' },
    codex_verification: { reason_codes: ['strand_signature_mismatch'] }
  });
  writeJson(path.join(helixRoot, 'sentinel_state.json'), {
    current_tier: 'stasis'
  });

  res = run(['run', '2026-02-26', `--policy=${policyPath}`, '--red-confidence=0.99', '--executed-cases=4', '--fail-cases=3', '--critical-fail-cases=2']);
  assert.strictEqual(res.status, 0, `war-mode run should pass in shadow mode: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'war-mode payload should be ok');
  assert.strictEqual(String(res.payload.mode || ''), 'war', 'mode should escalate to war under triple-consensus signals');
  assert.strictEqual(res.payload.consensus_pass, true, 'war-mode should report consensus_pass=true');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'status should be ok');
  assert.strictEqual(String(res.payload.mode || ''), 'war', 'status should reflect latest war mode transition');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('redteam_ant_colony.test.js: OK');
} catch (err) {
  console.error(`redteam_ant_colony.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


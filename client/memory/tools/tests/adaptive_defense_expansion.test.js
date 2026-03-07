#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'redteam', 'adaptive_defense_expansion.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-defense-'));
  const policyPath = path.join(tmp, 'config', 'redteam_adaptive_defense_policy.json');
  const root = path.join(tmp, 'state', 'security', 'red_team', 'adaptive_defense');
  const venomHistoryPath = path.join(tmp, 'state', 'security', 'venom_containment', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    defensive_only: true,
    hall_pass: {
      enabled: true,
      default_duration_hours: 12,
      max_duration_hours: 72,
      non_exemptible: ['defensive_only_invariant', 'constitution_root']
    },
    limits: {
      max_tool_proposals_per_run: 12,
      max_category_proposals_per_run: 3,
      max_friction_delay_ms: 1400,
      max_rate_limit_per_minute: 30,
      max_resource_sink_factor: 2.5,
      max_children_per_incident: 3,
      minimum_uplift_target: 0.2
    },
    paths: {
      state_root: root,
      latest_path: path.join(root, 'latest.json'),
      history_path: path.join(root, 'history.jsonl'),
      tool_catalog_path: path.join(root, 'tool_catalog.json'),
      cost_profiles_path: path.join(root, 'cost_profiles.json'),
      exemptions_path: path.join(root, 'exemptions.json'),
      registry_audit_path: path.join(root, 'exemption_audit.jsonl'),
      venom_history_path: venomHistoryPath
    }
  });

  const now = new Date().toISOString();
  const classes = ['gpu_heavy', 'cloud_vm', 'containerized', 'desktop'];
  const stages = ['tease', 'challenge', 'degrade', 'lockout'];
  for (let i = 0; i < 32; i += 1) {
    appendJsonl(venomHistoryPath, {
      type: 'venom_containment_evaluation',
      ts: now,
      unauthorized: true,
      runtime_class: classes[i % classes.length],
      stage: stages[i % stages.length]
    });
  }

  let res = run(['run', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'run payload should be ok');
  assert.ok(Number(res.payload.tool_proposals_added || 0) > 0, 'run should add tool proposals');
  assert.ok(Array.isArray(res.payload.new_categories), 'run should report new categories');
  assert.ok(res.payload.nasty_profiles && res.payload.nasty_profiles.tease_trap, 'nasty profiles should be present');

  res = run(['request-exemption', `--policy=${policyPath}`, '--scope=constitution_root', '--reason=should_fail']);
  assert.notStrictEqual(res.status, 0, 'non-exemptible scope should fail');
  assert.ok(res.payload && res.payload.ok === false, 'non-exemptible scope should fail in payload');

  res = run(['request-exemption', `--policy=${policyPath}`, '--scope=friction_tuning_lane', '--reason=threat_spike', '--duration-hours=8']);
  assert.strictEqual(res.status, 0, `request exemption should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'request exemption payload should be ok');
  const exId = String(res.payload.request && res.payload.request.id || '');
  assert.ok(exId, 'request should return exemption id');

  res = run(['approve-exemption', `--policy=${policyPath}`, `--id=${exId}`, '--approver=jay', '--approval-note=approved_for_shadow']);
  assert.strictEqual(res.status, 0, `approve exemption should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'approve exemption payload should be ok');

  res = run(['audit-exemptions', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(res.status, 0, `audit strict should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'strict audit payload should be ok');

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(res.payload.exemptions_active || 0) >= 1, 'status should include active exemptions');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('adaptive_defense_expansion.test.js: OK');
} catch (err) {
  console.error(`adaptive_defense_expansion.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

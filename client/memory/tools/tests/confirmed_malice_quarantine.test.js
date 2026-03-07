#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'helix', 'confirmed_malice_quarantine.js');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
}

function parse(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `expected JSON stdout (stderr=${proc.stderr || ''})`);
  return JSON.parse(raw);
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmed-malice-quarantine-'));
  const policyPath = path.join(tmp, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    require_sentinel_confirmed_malice: true,
    require_hunter_isolation_signal: true,
    release_requires_human: true,
    thresholds: {
      min_independent_signals_for_permanent_quarantine: 2,
      min_confidence_for_permanent_quarantine: 0.95
    },
    paths: {
      state_path: 'permanent_quarantine_state.json',
      latest_path: 'permanent_quarantine_latest.json',
      events_path: 'permanent_quarantine_events.jsonl',
      forensic_dir: 'forensics'
    }
  }, null, 2));

  const env = {
    ...process.env,
    HELIX_CONFIRMED_MALICE_POLICY_PATH: policyPath,
    HELIX_STATE_DIR: tmp
  };

  let r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'status should pass');
  let payload = parse(r);
  assert.strictEqual(payload.active, false);
  assert.strictEqual(payload.mode, 'idle');

  r = run([
    'evaluate',
    '--apply=1',
    '--input-json',
    JSON.stringify({
      sentinel: { tier: 'stasis', score: 2.8, reason_codes: ['sentinel_strand_mismatch'] },
      verifier: { mismatch_count: 1 },
      codex_verification: { ok: true, reason_codes: [] },
      hunter: { actions: [{ action: 'isolate_instance_perimeter' }] }
    })
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'evaluate non-malice should pass');
  payload = parse(r);
  assert.strictEqual(payload.state.active, false);
  assert.strictEqual(payload.state.mode, 'idle');

  r = run([
    'evaluate',
    '--apply=1',
    '--input-json',
    JSON.stringify({
      sentinel: {
        tier: 'confirmed_malice',
        score: 4,
        reason_codes: ['sentinel_strand_mismatch', 'sentinel_codex_verification_failed']
      },
      verifier: { mismatch_count: 3 },
      codex_verification: { ok: false, reason_codes: ['codex_signature_mismatch'] },
      hunter: { actions: [{ action: 'freeze_all_actuation' }, { action: 'isolate_instance_perimeter' }] },
      confirmed_malice_score_threshold: 3
    })
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'evaluate malice should pass');
  payload = parse(r);
  assert.strictEqual(payload.state.active, true, 'confirmed malice should activate permanent quarantine');
  assert.strictEqual(payload.state.mode, 'permanent_quarantine');
  assert.ok(payload.state.forensic_path, 'forensic path should exist when active');
  assert.ok(fs.existsSync(path.join(ROOT, payload.state.forensic_path)), 'forensic receipt should exist');

  r = run(['release'], env);
  assert.strictEqual(r.status, 1, 'release should require explicit human approval');
  payload = parse(r);
  assert.ok(Array.isArray(payload.reason_codes) && payload.reason_codes.includes('human_approval_required'));

  r = run(['release', '--human-approved=1'], env);
  assert.strictEqual(r.status, 0, 'release with human approval should pass');
  payload = parse(r);
  assert.strictEqual(payload.state.active, false);
  assert.strictEqual(payload.state.mode, 'idle');

  const statePath = path.join(tmp, 'permanent_quarantine_state.json');
  const finalState = readJson(statePath);
  assert.strictEqual(finalState.active, false);
  assert.strictEqual(finalState.mode, 'idle');

  console.log('confirmed_malice_quarantine.test.js: OK');
}

try {
  runTest();
} catch (err) {
  console.error(`confirmed_malice_quarantine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


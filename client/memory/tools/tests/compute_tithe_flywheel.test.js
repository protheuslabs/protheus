#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS_SCRIPT = path.join(ROOT, 'systems', 'economy', 'flywheel_acceptance_harness.js');
const PLATFORM_API = path.join(ROOT, 'platform', 'api', 'donate_gpu.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function runNode(script, args, env) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-tithe-flywheel-'));
  const policyPath = path.join(tmp, 'config', 'compute_tithe_flywheel_policy.json');
  const eventPolicyPath = path.join(tmp, 'config', 'event_sourced_control_plane_policy.json');

  const state = {
    contributions: path.join(tmp, 'state', 'economy', 'contributions.json'),
    donor: path.join(tmp, 'state', 'economy', 'donor_state.json'),
    latest: path.join(tmp, 'state', 'economy', 'latest.json'),
    receipts: path.join(tmp, 'state', 'economy', 'receipts.jsonl'),
    ledger: path.join(tmp, 'state', 'economy', 'tithe_ledger.jsonl'),
    streamEvents: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'events.jsonl'),
    soul: path.join(tmp, 'state', 'soul', 'gpu_patrons.json'),
    guardHint: path.join(tmp, 'state', 'security', 'guard', 'effective_tithe.json'),
    fractalHint: path.join(tmp, 'state', 'fractal', 'donor_priority_hints.json'),
    routingHint: path.join(tmp, 'state', 'routing', 'donor_priority_hints.json'),
    modelHint: path.join(tmp, 'state', 'routing', 'model_donor_priority_hints.json'),
    riskHint: path.join(tmp, 'state', 'routing', 'risk_donor_priority_hints.json'),
    chainReceipts: path.join(tmp, 'state', 'blockchain', 'tithe_bridge_receipts.jsonl'),
    streamRows: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'stream_events.jsonl'),
    views: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'materialized_views.json'),
    streamLatest: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'latest.json'),
    streamReceipts: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'receipts.jsonl'),
    streamAuthority: path.join(tmp, 'state', 'ops', 'event_sourced_control_plane', 'authority_state.json')
  };

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    base_tithe_rate: 0.1,
    min_tithe_rate: 0.01,
    max_discount_rate: 0.85,
    risk_tier_default: 2,
    discount_tiers: [
      { min_gpu_hours: 0, discount_rate: 0 },
      { min_gpu_hours: 100, discount_rate: 0.05 },
      { min_gpu_hours: 1000, discount_rate: 0.2 },
      { min_gpu_hours: 5000, discount_rate: 0.45 },
      { min_gpu_hours: 10000, discount_rate: 0.7 }
    ],
    paths: {
      contributions_path: state.contributions,
      donor_state_path: state.donor,
      latest_path: state.latest,
      receipts_path: state.receipts,
      ledger_path: state.ledger,
      event_stream_path: state.streamEvents,
      soul_marker_path: state.soul,
      guard_hint_path: state.guardHint,
      fractal_hint_path: state.fractalHint,
      routing_hint_path: state.routingHint,
      model_hint_path: state.modelHint,
      risk_hint_path: state.riskHint,
      chain_receipts_path: state.chainReceipts
    }
  });

  writeJson(eventPolicyPath, {
    enabled: true,
    shadow_only: false,
    authority: {
      source: 'local_authority'
    },
    jetstream: {
      enabled: false
    },
    paths: {
      events_path: state.streamEvents,
      stream_events_path: state.streamRows,
      views_path: state.views,
      latest_path: state.streamLatest,
      receipts_path: state.streamReceipts,
      authority_state_path: state.streamAuthority
    }
  });

  let out = runNode(HARNESS_SCRIPT, [`--policy=${policyPath}`, '--donor_id=sim', '--gpu_hours=240'], {
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: eventPolicyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'acceptance harness should pass');
  assert.ok(out.payload.applied && out.payload.applied.ok === true, 'apply should pass');
  assert.ok(Number(out.payload.applied.effective_tithe_rate || 1) < 0.1, 'effective tithe should be reduced');

  const donorState = readJson(state.donor, {});
  assert.ok(donorState.sim, 'donor state should be written');
  assert.ok(Number(donorState.sim.effective_tithe_rate || 1) < 0.1, 'donor effective tithe should be below base');

  const soul = readJson(state.soul, {});
  assert.ok(Array.isArray(soul.gpu_patrons), 'soul marker should include patrons');
  assert.ok(soul.gpu_patrons.includes('sim'), 'sim should be marked as gpu patron');

  const ledgerRows = readJsonl(state.ledger);
  assert.ok(ledgerRows.length >= 1, 'ledger rows should exist');
  assert.strictEqual(String(ledgerRows[0].type || ''), 'compute_tithe_applied');

  const streamRows = readJsonl(state.streamEvents);
  assert.ok(streamRows.length >= 1, 'event stream should have rows');
  assert.strictEqual(String(streamRows[0].stream || ''), 'economy');

  const chainRows = readJsonl(state.chainReceipts);
  assert.ok(chainRows.length >= 1, 'chain receipts should exist');

  assert.ok(fs.existsSync(state.guardHint), 'guard hint should exist');
  assert.ok(fs.existsSync(state.fractalHint), 'fractal hint should exist');
  assert.ok(fs.existsSync(state.routingHint), 'routing hint should exist');
  assert.ok(fs.existsSync(state.modelHint), 'model hint should exist');
  assert.ok(fs.existsSync(state.riskHint), 'risk hint should exist');

  out = runNode(PLATFORM_API, ['register', '--donor_id=platform_alice'], {
    COMPUTE_TITHE_POLICY_PATH: policyPath,
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: eventPolicyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'platform register should pass');
  assert.ok(String(out.payload.registration_token || '').startsWith('gpu_reg_'), 'registration token should be emitted');

  out = runNode(PLATFORM_API, ['donate', '--donor_id=platform_alice', '--gpu_hours=150', '--proof_ref=tx_platform_1'], {
    COMPUTE_TITHE_POLICY_PATH: policyPath,
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: eventPolicyPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'platform donate should pass');
  assert.ok(out.payload.applied && out.payload.applied.ok === true, 'platform donation should apply');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('compute_tithe_flywheel.test.js: OK');
} catch (err) {
  console.error(`compute_tithe_flywheel.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

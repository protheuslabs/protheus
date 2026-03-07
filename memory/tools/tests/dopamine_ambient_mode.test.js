#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOPAMINE_AMBIENT = path.join(ROOT, 'systems', 'dopamine', 'ambient.js');

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runAmbient(args, env = {}) {
  const out = spawnSync(process.execPath, [DOPAMINE_AMBIENT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(String(out.stdout || ''))
  };
}

function writePolicy(tempRoot) {
  const policyPath = path.join(tempRoot, 'mech_suit_mode_policy.json');
  const policy = {
    version: '1.0',
    enabled: true,
    state: {
      status_path: path.join(tempRoot, 'state', 'ops', 'mech_suit_mode', 'latest.json'),
      history_path: path.join(tempRoot, 'state', 'ops', 'mech_suit_mode', 'history.jsonl')
    },
    eyes: {
      push_attention_queue: true,
      attention_queue_path: path.join(tempRoot, 'state', 'attention', 'queue.jsonl'),
      receipts_path: path.join(tempRoot, 'state', 'attention', 'receipts.jsonl'),
      latest_path: path.join(tempRoot, 'state', 'attention', 'latest.json'),
      attention_contract: {
        max_queue_depth: 64,
        ttl_hours: 24,
        dedupe_window_hours: 24,
        backpressure_drop_below: 'critical',
        escalate_levels: ['critical'],
        priority_map: {
          critical: 100,
          warn: 60,
          info: 20
        }
      }
    },
    dopamine: {
      threshold_breach_only: true,
      surface_levels: ['warn', 'critical'],
      runtime_script: path.join(tempRoot, 'missing', 'dopamine_ambient_snapshot.js'),
      latest_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'receipts.jsonl')
    }
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  return policyPath;
}

try {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dopamine-ambient-'));
  const policyPath = writePolicy(tempRoot);
  const env = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1'
  };

  const nonBreachSummary = JSON.stringify({
    sds: 8,
    drift_minutes: 10,
    context_switches: 1,
    directive_pain: { active: false }
  });
  let out = runAmbient([
    'evaluate',
    `--summary-json=${nonBreachSummary}`,
    '--date=2026-03-06'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'non-breach evaluate should succeed');
  assert.strictEqual(out.payload.surfaced, false, 'non-breach evaluate should stay silent');
  assert.strictEqual(String(out.payload.attention_queue && out.payload.attention_queue.decision || ''), 'below_threshold', 'non-breach should report below-threshold decision');

  const breachSummary = JSON.stringify({
    sds: -5,
    drift_minutes: 180,
    context_switches: 9,
    directive_pain: { active: true }
  });
  out = runAmbient([
    'evaluate',
    `--summary-json=${breachSummary}`,
    '--date=2026-03-06'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'breach evaluate should succeed');
  assert.strictEqual(out.payload.surfaced, true, 'breach evaluate should surface');
  const decision = String(out.payload.attention_queue && out.payload.attention_queue.decision || '');
  assert.ok(['admitted', 'deduped', 'backpressure_drop'].includes(decision), 'breach should route through attention queue');

  out = runAmbient(['status', '--date=2026-03-06'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ambient_mode_active === true, 'status should confirm ambient mode active');
  assert.strictEqual(out.payload.threshold_breach_only, true, 'status should confirm threshold-only mode');
  assert.strictEqual(String(out.payload.status_source || ''), 'cached_latest', 'status should reuse cached receipt and avoid runtime snapshot polling');

  const receiptsPath = path.join(tempRoot, 'state', 'dopamine', 'ambient', 'receipts.jsonl');
  const queuePath = path.join(tempRoot, 'state', 'attention', 'queue.jsonl');
  assert.ok(fs.existsSync(receiptsPath), 'dopamine receipts file should be written');
  assert.ok(fs.existsSync(queuePath), 'attention queue file should exist after breach');
  assert.ok(fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).length >= 1, 'attention queue should contain at least one event');

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('dopamine_ambient_mode.test.js: OK');
} catch (err) {
  console.error(`dopamine_ambient_mode.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

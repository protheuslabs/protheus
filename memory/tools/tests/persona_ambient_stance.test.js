#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AMBIENT = path.join(ROOT, 'systems', 'personas', 'ambient_stance.js');

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
  const out = spawnSync(process.execPath, [AMBIENT, ...args], {
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
    eyes: {
      push_attention_queue: true,
      attention_queue_path: path.join(tempRoot, 'state', 'attention', 'queue.jsonl'),
      receipts_path: path.join(tempRoot, 'state', 'attention', 'receipts.jsonl'),
      latest_path: path.join(tempRoot, 'state', 'attention', 'latest.json'),
      attention_contract: {
        max_queue_depth: 32,
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
    personas: {
      ambient_stance: true,
      auto_apply: true,
      full_reload: false,
      cache_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'cache.json'),
      latest_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'receipts.jsonl'),
      max_personas: 8,
      max_patch_bytes: 8192
    }
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  return policyPath;
}

try {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-ambient-'));
  const policyPath = writePolicy(tempRoot);
  const env = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1'
  };

  let out = runAmbient([
    'apply',
    '--persona=guardian',
    '--stance-json={"risk_mode":"strict","temperature":0.2,"memory_priority":"high"}',
    '--source=test'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'first apply should succeed');
  assert.ok(out.payload.incremental_apply === true, 'apply should be incremental');
  assert.ok(out.payload.delta_applied === true, 'delta should be applied');
  const decisionA = String(out.payload && out.payload.attention_queue && out.payload.attention_queue.decision || '');
  assert.ok(['admitted', 'deduped', 'disabled'].includes(decisionA), 'attention queue decision should be accepted');

  out = runAmbient([
    'apply',
    '--persona=guardian',
    '--stance-json={"temperature":0.4,"risk_mode":null}',
    '--source=test'
  ], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'second apply should succeed');
  assert.ok(Array.isArray(out.payload.delta && out.payload.delta.changed_keys), 'delta changed keys should be present');
  assert.ok(Array.isArray(out.payload.delta && out.payload.delta.removed_keys), 'delta removed keys should be present');

  out = runAmbient([
    'apply',
    '--persona=guardian',
    '--full-reload=1',
    '--stance-json={"risk_mode":"strict"}',
    '--source=test'
  ], env);
  assert.notStrictEqual(out.status, 0, 'full reload should fail closed by policy');
  assert.ok(out.payload && out.payload.reason === 'full_reload_disabled_in_ambient_mode', 'full reload should be blocked');

  out = runAmbient(['status', '--persona=guardian'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ambient_mode_active === true, 'status should show ambient mode active');
  assert.ok(out.payload.persona_state && out.payload.persona_state.revision >= 1, 'persona state should persist revisions');

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('persona_ambient_stance.test.js: OK');
} catch (err) {
  console.error(`persona_ambient_stance.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

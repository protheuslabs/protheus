#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const COCKPIT = path.join(ROOT, 'systems', 'ops', 'cockpit_harness.js');
const PROTHEUSD = path.join(ROOT, 'systems', 'ops', 'protheusd.js');

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

function runOps(args, env = {}) {
  const out = spawnSync('cargo', ['run', '-q', '-p', 'protheus-ops-core', '--bin', 'protheus-ops', '--', ...args], {
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

function runNode(script, args, env = {}) {
  const out = spawnSync(process.execPath, [script, ...args], {
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
    spine: {
      heartbeat_hours: 4,
      manual_triggers_allowed: false,
      quiet_non_critical: true,
      silent_subprocess_output: true
    },
    eyes: {
      push_attention_queue: true,
      attention_queue_path: path.join(tempRoot, 'state', 'attention', 'queue.jsonl'),
      receipts_path: path.join(tempRoot, 'state', 'attention', 'receipts.jsonl'),
      latest_path: path.join(tempRoot, 'state', 'attention', 'latest.json'),
      attention_contract: {
        max_queue_depth: 64,
        max_batch_size: 16,
        cursor_state_path: path.join(tempRoot, 'state', 'attention', 'cursor_state.json'),
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
      receipts_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'receipts.jsonl')
    },
    dopamine: {
      threshold_breach_only: true,
      surface_levels: ['warn', 'critical'],
      latest_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'receipts.jsonl')
    }
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  return policyPath;
}

try {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-harness-'));
  const policyPath = writePolicy(tempRoot);
  const inboxDir = path.join(tempRoot, 'state', 'cockpit', 'inbox');
  const latestPath = path.join(inboxDir, 'latest.json');

  const env = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1',
    COCKPIT_INBOX_DIR: inboxDir
  };

  const event = {
    ts: '2026-03-06T00:00:00.000Z',
    source: 'external_eyes',
    source_type: 'external_item',
    severity: 'warn',
    summary: 'cockpit harness test event',
    attention_key: 'cockpit-harness-test-event'
  };
  let out = runOps(['attention-queue', 'enqueue', `--event-json=${JSON.stringify(event)}`], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'enqueue should succeed');

  out = runNode(COCKPIT, ['once', '--consumer=cockpit_test', '--limit=8'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'cockpit once should succeed');
  assert.strictEqual(Number(out.payload.sequence || 0), 1, 'first ingest sequence should be 1');
  assert.strictEqual(Number(out.payload.attention && out.payload.attention.batch_count || 0), 1, 'first ingest should consume one event');
  assert.ok(out.payload.memory_status && out.payload.memory_status.rust_authoritative === true, 'memory ambient status should be present and rust authoritative');
  assert.ok(fs.existsSync(latestPath), 'cockpit latest.json should be written');

  out = runNode(COCKPIT, ['once', '--consumer=cockpit_test', '--limit=8'], env);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'second cockpit once should succeed');
  assert.strictEqual(Number(out.payload.sequence || 0), 2, 'second ingest sequence should be 2');
  assert.strictEqual(Number(out.payload.attention && out.payload.attention.batch_count || 0), 0, 'second ingest should have empty batch');

  out = runNode(PROTHEUSD, ['status'], {
    ...env,
    COCKPIT_INBOX_LATEST_PATH: latestPath
  });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && typeof out.payload === 'object', 'protheusd status should return JSON payload');
  const cockpitSummary = out.payload.event && out.payload.event.detail
    ? out.payload.event.detail.cockpit_context
    : out.payload.cockpit;
  assert.ok(cockpitSummary && cockpitSummary.available === true, 'status should surface cockpit summary');
  assert.strictEqual(Number(cockpitSummary.sequence || 0), 2, 'status should show latest cockpit sequence');

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('cockpit_harness.test.js: OK');
} catch (err) {
  console.error(`cockpit_harness.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

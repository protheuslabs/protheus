#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVENT_CANON = path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');
const EVENT_ALIAS = path.join(ROOT, 'systems', 'state', 'event_stream.js');
const AUTO_CANON = path.join(ROOT, 'systems', 'ops', 'trace_habit_autogenesis.js');
const AUTO_ALIAS = path.join(ROOT, 'systems', 'autogenesis', 'trace_habit_autogenesis.js');
const AUTO_LOOP_ALIAS = path.join(ROOT, 'systems', 'autogenesis', 'trace_habit_loop.js');

function run(script, args, env) {
  const proc = spawnSync('node', [script].concat(args), {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  let payload = null;
  try {
    payload = JSON.parse(String(proc.stdout || '').trim());
  } catch {}
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    payload,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-alias-'));
  const stateDir = path.join(tmp, 'state');
  const configDir = path.join(tmp, 'config');
  const eventPolicyPath = path.join(configDir, 'event_sourced_control_plane_policy.json');
  const autoPolicyPath = path.join(configDir, 'trace_habit_autogenesis_policy.json');
  const aliasReceiptsPath = path.join(stateDir, 'ops', 'legacy_path_alias_adapters', 'receipts.jsonl');
  const aliasLatestPath = path.join(stateDir, 'ops', 'legacy_path_alias_adapters', 'latest.json');

  writeJson(eventPolicyPath, {
    enabled: true,
    shadow_only: true,
    authority: {
      source: 'local_authority',
      strict_reconcile: true,
      rollback_on_partition: true
    },
    jetstream: {
      enabled: false,
      shadow_only: true
    },
    paths: {
      events_path: path.join(stateDir, 'ops', 'event', 'events.jsonl'),
      stream_events_path: path.join(stateDir, 'ops', 'event', 'stream_events.jsonl'),
      views_path: path.join(stateDir, 'ops', 'event', 'materialized_views.json'),
      latest_path: path.join(stateDir, 'ops', 'event', 'latest.json'),
      receipts_path: path.join(stateDir, 'ops', 'event', 'receipts.jsonl'),
      jetstream_latest_path: path.join(stateDir, 'ops', 'event', 'jetstream_latest.json'),
      authority_state_path: path.join(stateDir, 'ops', 'event', 'authority_state.json'),
      reconcile_latest_path: path.join(stateDir, 'ops', 'event', 'reconcile_latest.json'),
      rollback_latest_path: path.join(stateDir, 'ops', 'event', 'rollback_latest.json')
    }
  });

  writeJson(autoPolicyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      queue_path: path.join(stateDir, 'ops', 'autogenesis', 'queue.json'),
      latest_path: path.join(stateDir, 'ops', 'autogenesis', 'latest.json'),
      receipts_path: path.join(stateDir, 'ops', 'autogenesis', 'receipts.jsonl'),
      reports_dir: path.join(stateDir, 'ops', 'autogenesis', 'reports')
    },
    gates: {
      min_failure_count: 1,
      min_confidence: 0.8,
      max_candidates_per_cycle: 3
    }
  });

  const fixedNow = '2026-03-01T12:00:00.000Z';
  const commonEnv = {
    PROTHEUS_NOW_ISO: fixedNow,
    LEGACY_ALIAS_ADAPTER_RECEIPTS_PATH: aliasReceiptsPath,
    LEGACY_ALIAS_ADAPTER_LATEST_PATH: aliasLatestPath
  };

  const eventEnv = {
    ...commonEnv,
    EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH: eventPolicyPath
  };
  const autoEnv = {
    ...commonEnv,
    TRACE_HABIT_AUTOGENESIS_POLICY_PATH: autoPolicyPath
  };

  const canonicalEvent = run(EVENT_CANON, ['status'], eventEnv);
  const aliasEvent = run(EVENT_ALIAS, ['status'], eventEnv);
  assert.strictEqual(canonicalEvent.status, 0, canonicalEvent.stderr);
  assert.strictEqual(aliasEvent.status, 0, aliasEvent.stderr);
  assert.deepStrictEqual(aliasEvent.payload, canonicalEvent.payload, 'event_stream alias payload must match canonical output');

  const canonicalAuto = run(AUTO_CANON, ['status'], autoEnv);
  const aliasAuto = run(AUTO_ALIAS, ['status'], autoEnv);
  assert.strictEqual(canonicalAuto.status, 0, canonicalAuto.stderr);
  assert.strictEqual(aliasAuto.status, 0, aliasAuto.stderr);
  assert.deepStrictEqual(aliasAuto.payload, canonicalAuto.payload, 'autogenesis alias payload must match canonical output');

  const aliasLoop = run(AUTO_LOOP_ALIAS, ['status'], autoEnv);
  assert.strictEqual(aliasLoop.status, 0, aliasLoop.stderr);
  assert.deepStrictEqual(aliasLoop.payload, canonicalAuto.payload, 'trace_habit_loop alias payload must match canonical output');

  const receiptRows = fs.readFileSync(aliasReceiptsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(receiptRows.length >= 3, 'alias adapter should emit receipts for alias invocations');
  assert.ok(receiptRows.some((row) => row.alias_path === 'client/systems/state/event_stream.js'), 'event_stream alias receipt missing');
  assert.ok(receiptRows.some((row) => row.alias_path === 'client/systems/autogenesis/trace_habit_autogenesis.js'), 'trace_habit_autogenesis alias receipt missing');
  assert.ok(receiptRows.some((row) => row.alias_path === 'client/systems/autogenesis/trace_habit_loop.js'), 'trace_habit_loop alias receipt missing');
  assert.ok(receiptRows.every((row) => row.deprecated === true), 'all alias adapter receipts should be marked deprecated');

  const latest = JSON.parse(fs.readFileSync(aliasLatestPath, 'utf8'));
  assert.strictEqual(latest.schema_id, 'legacy_path_alias_adapter_latest');
  assert.strictEqual(latest.exit_code, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('legacy_path_alias_adapters.test.js: OK');
} catch (err) {
  console.error(`legacy_path_alias_adapters.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

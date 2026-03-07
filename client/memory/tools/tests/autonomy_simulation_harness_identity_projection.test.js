#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runHarness(scriptPath, root, env, dateStr) {
  const proc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--days=1',
    '--write=0'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(proc.status, 0, proc.stderr || 'harness run should pass');
  const payload = parsePayload(proc.stdout);
  assert.ok(payload && payload.ok === true, 'harness payload should be valid');
  return payload;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'autonomy_simulation_harness.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-sim-identity-'));
  const dateStr = '2026-02-25';

  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const proposalsDir = path.join(tmp, 'state', 'sensory', 'proposals');
  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    {
      ts: '2026-02-25T01:00:00.000Z',
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      objective_id: 'T1_make_jay_billionaire_v1',
      proposal_id: 'SIM-PROP-1'
    },
    {
      ts: '2026-02-25T01:05:00.000Z',
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'no_change',
      objective_id: 'UNKNOWN_OBJECTIVE_SHOULD_BLOCK',
      proposal_id: 'SIM-PROP-2'
    }
  ]);

  // Minimal proposals file to keep queue snapshot logic deterministic.
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.writeFileSync(path.join(proposalsDir, `${dateStr}.json`), '[]\n', 'utf8');

  const baseEnv = {
    ...process.env,
    AUTONOMY_SIM_RUNS_DIR: runsDir,
    AUTONOMY_SIM_PROPOSALS_DIR: proposalsDir,
    AUTONOMY_SIM_LINEAGE_REQUIRED: '0'
  };

  const offPayload = runHarness(scriptPath, root, {
    ...baseEnv,
    AUTONOMY_SIM_IDENTITY_PROJECTION_ENABLED: '0',
    SPINE_IDENTITY_ANCHOR_ENABLED: '0'
  }, dateStr);
  assert.ok(offPayload.identity_projection && offPayload.identity_projection.enabled === false, 'identity projection should be disabled');
  assert.strictEqual(Number(offPayload.effective_counters.attempts || 0), 2, 'without identity projection both attempts should count');

  const onPayload = runHarness(scriptPath, root, {
    ...baseEnv,
    AUTONOMY_SIM_IDENTITY_PROJECTION_ENABLED: '1',
    AUTONOMY_SIM_IDENTITY_BLOCK_UNKNOWN_OBJECTIVE: '1',
    SPINE_IDENTITY_ANCHOR_ENABLED: '1'
  }, dateStr);
  assert.ok(onPayload.identity_projection && onPayload.identity_projection.enabled === true, 'identity projection should be enabled');
  assert.ok(Number(onPayload.identity_projection.blocked_attempts || 0) >= 1, 'identity projection should block unknown objective attempt');
  assert.strictEqual(Number(onPayload.effective_counters.attempts || 0), 1, 'with identity projection one attempt should be filtered');
  assert.ok(Number(onPayload.identity_projection.summary && onPayload.identity_projection.summary.blocked || 0) >= 1, 'identity summary should report blocked rows');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autonomy_simulation_harness_identity_projection.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_simulation_harness_identity_projection.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

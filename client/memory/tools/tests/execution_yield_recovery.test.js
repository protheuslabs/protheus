#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  write(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'execution_yield_recovery.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-yield-recovery-'));
  const queueLogPath = path.join(tmp, 'state', 'sensory', 'queue_log.jsonl');
  const proposalsDir = path.join(tmp, 'state', 'sensory', 'proposals');
  const decisionsDir = path.join(tmp, 'state', 'queue', 'decisions');
  const eyesRegistryPath = path.join(tmp, 'state', 'sensory', 'eyes', 'registry.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'history.jsonl');
  const throttlePath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'intake_throttle.json');
  const salvagePath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'escalation_salvage.jsonl');
  const eyeActionsPath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'eye_actions.jsonl');
  const artifactStatePath = path.join(tmp, 'state', 'ops', 'execution_yield_recovery', 'artifact_state.json');
  const policyPath = path.join(tmp, 'config', 'execution_yield_recovery_policy.json');
  const mockBridgePath = path.join(tmp, 'mock_bridge.js');
  const mockBridgeLogPath = path.join(tmp, 'bridge_calls.jsonl');
  const date = '2026-03-01';

  write(mockBridgePath, [
    '#!/usr/bin/env node',
    '\'use strict\';',
    'const fs = require(\'fs\');',
    'const path = require(\'path\');',
    'const outPath = process.env.MOCK_BRIDGE_LOG_PATH;',
    'if (!outPath) process.exit(2);',
    'fs.mkdirSync(path.dirname(outPath), { recursive: true });',
    'fs.appendFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), argv: process.argv.slice(2) }) + \'\\n\');'
  ].join('\n'));

  writeJson(path.join(proposalsDir, '2026-03-01.json'), {
    proposals: [
      {
        id: 'P-HIGH1',
        title: 'High-worth open proposal',
        type: 'external_intel',
        execution_worthiness_score: 91,
        action_spec: {
          version: 1,
          objective: 'Ship high-worth proposal',
          target: 'proposal:P-HIGH1',
          next_command: 'node client/habits/scripts/proposal_queue.js accept P-HIGH1 "ship now"',
          verify: ['decision recorded', 'outcome logged'],
          rollback: 'mark rejected with reason rollback_test'
        }
      },
      {
        id: 'P-MISS',
        title: 'Filtered missing action spec',
        type: 'external_intel',
        execution_worthiness_score: 92,
        suggested_next_command: 'node client/habits/scripts/proposal_queue.js accept P-MISS "recover missing spec"'
      },
      {
        id: 'P-LOW1',
        title: 'Low-priority open proposal',
        type: 'external_intel',
        execution_worthiness_score: 42
      },
      {
        id: 'P-SHIP',
        title: 'Already shipped item',
        type: 'external_intel',
        execution_worthiness_score: 88
      }
    ]
  });
  writeJson(path.join(proposalsDir, '2026-02-25.json'), {
    proposals: [
      {
        id: 'P-ESC-HIGH',
        title: 'Escalation high score salvage',
        type: 'pain_escalation',
        execution_worthiness_score: 91
      },
      {
        id: 'P-ESC-LOW',
        title: 'Escalation low score reject',
        type: 'pain_escalation',
        execution_worthiness_score: 38
      }
    ]
  });

  writeJsonl(queueLogPath, [
    {
      ts: '2026-02-25T00:00:00.000Z',
      type: 'proposal_generated',
      date: '2026-02-25',
      proposal_id: 'P-ESC-HIGH',
      title: 'Escalation high score salvage',
      proposal_hash: 'hash-esc-high',
      status_after: 'open',
      execution_worthiness_score: 91,
      source: 'sensory_queue'
    },
    {
      ts: '2026-02-25T00:05:00.000Z',
      type: 'proposal_generated',
      date: '2026-02-25',
      proposal_id: 'P-ESC-LOW',
      title: 'Escalation low score reject',
      proposal_hash: 'hash-esc-low',
      status_after: 'open',
      execution_worthiness_score: 38,
      source: 'sensory_queue'
    },
    {
      ts: '2026-03-01T10:00:00.000Z',
      type: 'proposal_generated',
      date: '2026-03-01',
      proposal_id: 'P-HIGH1',
      title: 'High-worth open proposal',
      proposal_hash: 'hash-high1',
      status_after: 'open',
      execution_worthiness_score: 91,
      source: 'sensory_queue'
    },
    {
      ts: '2026-03-01T10:03:00.000Z',
      type: 'proposal_filtered',
      date: '2026-03-01',
      proposal_id: 'P-MISS',
      title: 'Filtered missing action spec',
      proposal_hash: 'hash-miss',
      status_after: 'filtered',
      filter_reason: 'action_spec_missing',
      execution_worthiness_score: 92,
      source: 'sensory_queue'
    },
    {
      ts: '2026-03-01T10:05:00.000Z',
      type: 'proposal_generated',
      date: '2026-03-01',
      proposal_id: 'P-LOW1',
      title: 'Low-priority open proposal',
      proposal_hash: 'hash-low1',
      status_after: 'open',
      execution_worthiness_score: 42,
      source: 'sensory_queue'
    }
  ]);

  writeJsonl(path.join(decisionsDir, '2026-03-01.jsonl'), [
    {
      ts: '2026-03-01T11:00:00.000Z',
      type: 'outcome',
      proposal_id: 'P-SHIP',
      outcome: 'shipped',
      evidence_ref: 'receipt:P-SHIP:01'
    }
  ]);

  writeJson(eyesRegistryPath, {
    version: '1.0',
    eyes: [
      {
        id: 'eye_bad',
        status: 'probation',
        consecutive_failures: 4,
        error_rate: 0.9,
        self_heal_attempts: 6
      }
    ]
  });

  writeJson(policyPath, {
    schema_id: 'execution_yield_recovery_policy',
    schema_version: '1.0-test',
    enabled: true,
    strict_default: false,
    window_days: 14,
    dead_window_days: 7,
    paths: {
      queue_log_path: queueLogPath,
      proposals_dir: proposalsDir,
      decisions_dir: decisionsDir,
      eyes_registry_path: eyesRegistryPath,
      latest_path: latestPath,
      history_path: historyPath,
      throttle_state_path: throttlePath,
      salvage_queue_path: salvagePath,
      eye_actions_history_path: eyeActionsPath,
      artifact_state_path: artifactStatePath
    },
    top_k: {
      enabled: true,
      reserve_count: 1,
      min_score: 80,
      max_age_hours: 240
    },
    filter_rebalance: {
      enabled: true,
      high_score_threshold: 85,
      stale_defer_hours: 24,
      reasons: ['action_spec_missing', 'stale_open_age_sweep', 'composite_low']
    },
    queue_backpressure: {
      enabled: true,
      max_open: 1,
      max_open_p95_age_hours: 24,
      low_priority_score_threshold: 75
    },
    eye_health: {
      enabled: true,
      fail_streak_threshold: 2,
      error_rate_threshold: 0.7,
      max_auto_heal_attempts: 2
    },
    execution_floor: {
      enabled: true,
      min_shipped_per_day: 2,
      catchup_top_k: 1,
      observation_override: false
    },
    artifact_bridge: {
      enabled: true,
      mode: 'command',
      command: [process.execPath, mockBridgePath],
      directive: 'queue_outcome_shipped_v1'
    },
    escalation_ttl: {
      enabled: true,
      base_hours: 16,
      min_hours: 6,
      max_hours: 72,
      high_score_threshold: 85,
      high_score_factor: 2,
      low_score_threshold: 60,
      low_score_factor: 0.5,
      salvage_score_threshold: 85
    },
    event_stream: {
      enabled: false,
      script_path: path.join(repoRoot, 'systems', 'ops', 'event_sourced_control_plane.js'),
      stream: 'ops',
      event: 'yield_recovery_tick'
    }
  });

  const proc = runNode(
    scriptPath,
    ['run', date, '--apply=1', '--strict=0', `--policy=${policyPath}`],
    { MOCK_BRIDGE_LOG_PATH: mockBridgeLogPath },
    repoRoot
  );
  assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
  const payload = parseJsonOutput(proc.stdout);
  assert.ok(payload && payload.ok === true, 'yield recovery payload should be ok');
  assert.strictEqual(payload.type, 'execution_yield_recovery');
  assert.ok(payload.filter_rebalance && Array.isArray(payload.filter_rebalance.recovered), 'filter rebalance payload should exist');
  assert.ok(
    payload.filter_rebalance.recovered.some((row) => String(row.proposal_id) === 'P-MISS'),
    'P-MISS should be recovered via rewrite lane'
  );
  assert.ok(payload.top_k && Array.isArray(payload.top_k.applied), 'top_k payload should include applied list');
  assert.ok(payload.top_k.applied.length >= 1, 'top_k reservation should apply at least one proposal');
  assert.ok(payload.queue_backpressure && payload.queue_backpressure.triggered === true, 'queue backpressure should trigger');
  assert.ok(payload.execution_floor && payload.execution_floor.miss_floor === true, 'execution floor miss should be detected');
  assert.ok(payload.eye_health && Number(payload.eye_health.actions_count || 0) >= 1, 'eye health action should be emitted');
  assert.ok(payload.adaptive_escalation_ttl && Number(payload.adaptive_escalation_ttl.salvage_count || 0) >= 1, 'escalation salvage expected');
  assert.ok(payload.adaptive_escalation_ttl && Number(payload.adaptive_escalation_ttl.reject_count || 0) >= 1, 'escalation reject expected');

  const updatedToday = readJson(path.join(proposalsDir, '2026-03-01.json'));
  const updatedRows = Array.isArray(updatedToday) ? updatedToday : updatedToday.proposals;
  const missRow = updatedRows.find((row) => row && row.id === 'P-MISS');
  assert.ok(missRow && missRow.action_spec && typeof missRow.action_spec === 'object', 'P-MISS should have synthesized action_spec');

  const queueRows = readJsonl(queueLogPath);
  assert.ok(
    queueRows.some((row) => row.type === 'proposal_generated' && row.proposal_id === 'P-MISS' && row.recovered_from_filter_reason === 'action_spec_missing'),
    'Recovered proposal should be re-generated into open lane'
  );
  assert.ok(
    queueRows.some((row) => row.type === 'proposal_snoozed' && row.proposal_id === 'P-ESC-HIGH'),
    'High-score escalation should be salvaged (snoozed)'
  );
  assert.ok(
    queueRows.some((row) => row.type === 'proposal_rejected' && row.proposal_id === 'P-ESC-LOW'),
    'Low-score escalation should be rejected'
  );

  const throttle = readJson(throttlePath);
  assert.strictEqual(throttle.enabled, true, 'throttle state should be enabled under pressure');
  assert.ok(fs.existsSync(salvagePath), 'salvage queue file should be written');
  assert.ok(fs.existsSync(eyeActionsPath), 'eye actions history should be written');
  const bridgeCalls = readJsonl(mockBridgeLogPath);
  assert.ok(bridgeCalls.length >= 1, 'artifact bridge command should execute');
  assert.ok(
    bridgeCalls.some((row) => Array.isArray(row.argv) && row.argv.some((arg) => String(arg).includes('P-SHIP'))),
    'artifact bridge should receive shipped proposal id'
  );
  assert.ok(fs.existsSync(latestPath), 'latest status file should exist');
  assert.ok(fs.existsSync(historyPath), 'history file should exist');

  console.log('execution_yield_recovery.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`execution_yield_recovery.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controllerPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function mkTempRunsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-exec-confidence-'));
  const runsDir = path.join(root, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  return { root, runsDir };
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function loadController(rustEnabled, runsDir) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  process.env.AUTONOMY_RUNS_DIR = runsDir;
  delete require.cache[controllerPath];
  delete require.cache[bridgePath];
  return require(controllerPath);
}

function mapToSortedObject(map) {
  const out = {};
  const entries = map instanceof Map ? Array.from(map.entries()) : [];
  entries
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .forEach(([key, value]) => {
      out[String(key)] = Number(value || 0);
    });
  return out;
}

function normalizeNumberObject(obj) {
  return {
    executed: Number(obj && obj.executed || 0),
    shipped: Number(obj && obj.shipped || 0),
    no_change: Number(obj && obj.no_change || 0),
    reverted: Number(obj && obj.reverted || 0)
  };
}

function run() {
  const { runsDir } = mkTempRunsDir();
  const date = '2026-03-04';
  const priorDate = '2026-03-03';

  writeJsonl(path.join(runsDir, `${priorDate}.jsonl`), [
    {
      type: 'autonomy_run',
      ts: '2026-03-03T20:00:00.000Z',
      proposal_key: 'k:deploy:1',
      result: 'executed',
      outcome: 'shipped',
      capability_key: 'proposal:deploy',
      proposal_type: 'deploy'
    }
  ]);

  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    {
      type: 'autonomy_run',
      ts: '2026-03-04T08:00:00.000Z',
      proposal_key: 'k:deploy:1',
      result: 'score_only_preview',
      capability_key: 'proposal:deploy',
      proposal_type: 'deploy'
    },
    {
      type: 'autonomy_run',
      ts: '2026-03-04T09:00:00.000Z',
      proposal_key: 'k:deploy:1',
      result: 'stop_repeat_gate_candidate_exhausted',
      capability_key: 'proposal:deploy',
      proposal_type: 'deploy'
    },
    {
      type: 'autonomy_run',
      ts: '2026-03-04T10:00:00.000Z',
      proposal_key: 'k:deploy:2',
      result: 'executed',
      outcome: 'no_change',
      capability_key: 'proposal:deploy',
      proposal_type: 'deploy'
    },
    {
      type: 'autonomy_run',
      ts: '2026-03-04T11:00:00.000Z',
      proposal_key: 'k:ops:1',
      result: 'executed',
      outcome: 'reverted',
      capability_key: 'proposal:ops',
      proposal_type: 'ops'
    },
    {
      type: 'queue_event',
      ts: '2026-03-04T11:30:00.000Z',
      proposal_key: 'k:noise',
      result: 'executed',
      outcome: 'shipped',
      capability_key: 'proposal:deploy',
      proposal_type: 'deploy'
    }
  ]);

  const fixedNow = Date.parse('2026-03-04T12:00:00.000Z');
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;

  try {
    const ts = loadController(false, runsDir);
    const rust = loadController(true, runsDir);

    const recentTs = mapToSortedObject(ts.recentProposalKeyCounts(date, 48));
    const recentRust = mapToSortedObject(rust.recentProposalKeyCounts(date, 48));
    assert.deepStrictEqual(recentRust, recentTs, 'recentProposalKeyCounts mismatch');

    const descriptor = { key: 'proposal:deploy', aliases: ['proposal'] };
    assert.strictEqual(
      Number(rust.capabilityAttemptCountForDate(date, descriptor)),
      Number(ts.capabilityAttemptCountForDate(date, descriptor)),
      'capabilityAttemptCountForDate mismatch'
    );

    const statsTs = normalizeNumberObject(ts.capabilityOutcomeStatsInWindow(date, descriptor, 7));
    const statsRust = normalizeNumberObject(rust.capabilityOutcomeStatsInWindow(date, descriptor, 7));
    assert.deepStrictEqual(statsRust, statsTs, 'capabilityOutcomeStatsInWindow mismatch');

    const histTs = ts.collectExecuteConfidenceHistory(date, 'deploy', 'proposal:deploy', 7);
    const histRust = rust.collectExecuteConfidenceHistory(date, 'deploy', 'proposal:deploy', 7);
    assert.deepStrictEqual(histRust, histTs, 'collectExecuteConfidenceHistory mismatch');

    const proposal = { type: 'deploy' };
    const policyTs = ts.computeExecuteConfidencePolicy(date, proposal, 'proposal:deploy', 'low', 'canary_execute');
    const policyRust = rust.computeExecuteConfidencePolicy(date, proposal, 'proposal:deploy', 'low', 'canary_execute');
    assert.deepStrictEqual(policyRust, policyTs, 'computeExecuteConfidencePolicy mismatch');

    console.log('autonomy_execute_confidence_lane_rust_parity.test.js: OK');
  } finally {
    Date.now = originalDateNow;
  }
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execute_confidence_lane_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

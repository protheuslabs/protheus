#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'autonomy', 'mirror_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-organ-'));
  const dateStr = '2026-02-25';
  const day2 = '2026-02-24';

  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const simDir = path.join(tmp, 'state', 'autonomy', 'simulations');
  const introspectionDir = path.join(tmp, 'state', 'autonomy', 'fractal', 'introspection');
  const regimeLatestPath = path.join(tmp, 'state', 'autonomy', 'fractal', 'regime', 'latest.json');
  const outDir = path.join(tmp, 'state', 'autonomy', 'mirror_organ');
  const policyPath = path.join(tmp, 'config', 'mirror_organ_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_mode: true,
    proposal_only: true,
    window_days: 3,
    max_proposals: 6,
    min_confidence: 0.55,
    thresholds: {
      drift_warn: 0.03,
      drift_critical: 0.06,
      yield_warn: 0.68,
      yield_critical: 0.55,
      hold_warn: 0.35,
      hold_critical: 0.6,
      no_change_warn: 0.45,
      no_change_critical: 0.75
    },
    weights: {
      drift: 0.28,
      yield: 0.24,
      hold: 0.2,
      no_change: 0.16,
      queue: 0.12
    },
    queue: {
      normal: 0,
      elevated: 0.35,
      high: 0.72,
      critical: 1
    }
  });

  writeJsonl(path.join(runsDir, `${day2}.jsonl`), [
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'workflow', result: 'executed', outcome: 'no_change' },
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'workflow', result: 'policy_hold', outcome: 'no_change' }
  ]);
  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'workflow', result: 'executed', outcome: 'no_change' },
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'workflow', result: 'executed', outcome: 'no_change' },
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'workflow', result: 'policy_hold', outcome: 'no_change' },
    { type: 'autonomy_run', objective_id: 't1_growth', proposal_type: 'ops', result: 'executed', outcome: 'shipped' }
  ]);

  writeJson(path.join(simDir, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.051 },
      yield_rate: { value: 0.61 }
    }
  });

  writeJson(path.join(introspectionDir, `${dateStr}.json`), {
    snapshot: {
      queue: { pressure: 'high' },
      autopause: { active: false }
    },
    restructure_candidates: [{ id: 'cand_1' }, { id: 'cand_2' }]
  });

  writeJson(regimeLatestPath, {
    selected_regime: 'quality',
    candidate_confidence: 0.74,
    switched: true
  });

  const env = {
    ...process.env,
    MIRROR_ORGAN_RUNS_DIR: runsDir,
    MIRROR_ORGAN_SIM_DIR: simDir,
    MIRROR_ORGAN_INTROSPECTION_DIR: introspectionDir,
    MIRROR_ORGAN_REGIME_LATEST_PATH: regimeLatestPath,
    MIRROR_ORGAN_OUT_DIR: outDir
  };

  const runProc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    `--policy=${policyPath}`,
    '--days=3',
    '--max-proposals=4'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run should succeed');
  const runOut = parseJson(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'run payload should be ok');
  assert.strictEqual(runOut.execution_mode, 'proposal_only');
  assert.ok(Number(runOut.proposal_count || 0) > 0, 'should emit at least one proposal');

  const latestPath = path.join(outDir, 'latest.json');
  assert.ok(fs.existsSync(latestPath), 'latest snapshot should be written');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.strictEqual(latest.proposal_only, true);
  assert.ok(Array.isArray(latest.proposals) && latest.proposals.length > 0, 'latest should include proposals');

  const suggestionsPath = path.join(outDir, 'suggestions', `${dateStr}.json`);
  assert.ok(fs.existsSync(suggestionsPath), 'suggestion snapshot should be written');
  const suggestions = JSON.parse(fs.readFileSync(suggestionsPath, 'utf8'));
  assert.ok(Array.isArray(suggestions) && suggestions.length > 0, 'suggestions should exist');
  assert.ok(suggestions.every((row) => String(row.source || '') === 'mirror_organ'), 'suggestions should be mirror source');

  const firstProposal = latest.proposals[0];
  const replayProc = spawnSync(process.execPath, [
    scriptPath,
    'replay',
    `--proposal-id=${firstProposal.id}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(replayProc.status, 0, replayProc.stderr || 'replay should succeed');
  const replayOut = parseJson(replayProc.stdout);
  assert.ok(replayOut && replayOut.ok === true, 'replay payload should be ok');
  assert.strictEqual(String(replayOut.proposal && replayOut.proposal.id || ''), String(firstProposal.id));
  assert.ok(Array.isArray(replayOut.evidence_refs) && replayOut.evidence_refs.length > 0, 'replay should include evidence refs');

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', 'latest'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should succeed');
  const statusOut = parseJson(statusProc.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status payload should be ok');
  assert.ok(Number(statusOut.proposal_count || 0) > 0, 'status should expose proposal count');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mirror_organ.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`mirror_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

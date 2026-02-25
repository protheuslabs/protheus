#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHADOW_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'collective_shadow.js');
const CONTROLLER_PATH = path.join(ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function mkDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function parsePayload(stdout) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch {}
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars || {})) {
    prev[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars || {})) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadController(vars = {}) {
  return withEnv(vars, () => {
    delete require.cache[require.resolve(CONTROLLER_PATH)];
    return require(CONTROLLER_PATH);
  });
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collective-shadow-'));
  const dateStr = '2026-02-25';
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const redTeamRunsDir = path.join(tmp, 'state', 'security', 'red_team', 'runs');
  const outDir = path.join(tmp, 'state', 'autonomy', 'collective_shadow');
  const policyPath = path.join(tmp, 'config', 'collective_shadow_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    window_days: 7,
    min_occurrences: 2,
    max_archetypes: 20,
    avoid_failure_rate_min: 0.6,
    reinforce_success_rate_min: 0.6,
    min_confidence: 0.0,
    penalty_base: 2,
    penalty_slope: 10,
    penalty_max: 10,
    bonus_base: 0.3,
    bonus_slope: 5,
    bonus_max: 4,
    red_team_pressure: {
      enabled: true,
      min_runs: 1,
      critical_fail_penalty: 2,
      high_fail_rate_penalty: 1,
      fail_rate_threshold: 0.3
    }
  });

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'unknown', risk: 'medium' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'unknown', risk: 'medium' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', risk: 'low' },
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'external_intel', risk: 'low' }
  ]);

  writeJson(path.join(redTeamRunsDir, `${dateStr}_sample.json`), {
    ts: `${dateStr}T12:00:00.000Z`,
    summary: {
      executed_cases: 4,
      fail_cases: 2,
      critical_fail_cases: 1
    }
  });

  const env = {
    ...process.env,
    COLLECTIVE_SHADOW_RUNS_DIR: runsDir,
    COLLECTIVE_SHADOW_RED_TEAM_RUNS_DIR: redTeamRunsDir,
    COLLECTIVE_SHADOW_OUT_DIR: outDir
  };

  const runProc = spawnSync(process.execPath, [SHADOW_SCRIPT, 'run', dateStr, '--days=7', `--policy=${policyPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'collective shadow run should pass');
  const runOut = parsePayload(runProc.stdout);
  assert.ok(runOut && runOut.ok === true, 'shadow run should return ok');
  assert.ok(Number(runOut.archetypes_total || 0) >= 2, 'shadow run should emit archetypes');

  const latestPath = path.join(outDir, 'latest.json');
  assert.ok(fs.existsSync(latestPath), 'latest snapshot should be written');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.ok(Array.isArray(latest.archetypes) && latest.archetypes.length > 0, 'snapshot should include archetypes');
  assert.ok(
    latest.archetypes.some((row) => String(row.kind || '') === 'avoid'),
    'snapshot should include avoid archetype'
  );

  const candidate = {
    proposal: {
      id: 'CAND-001',
      type: 'unknown',
      expected_impact: 'medium',
      risk: 'medium',
      meta: { objective_id: 'objective_alpha' }
    },
    objective_binding: { objective_id: 'objective_alpha' },
    capability_key: 'proposal:unknown',
    composite_score: 70,
    actionability: { score: 70 },
    directive_fit: { score: 70 },
    quality: { score: 70 }
  };

  const baseEnv = {
    AUTONOMY_STRATEGY_RANK_NON_YIELD_PENALTY_ENABLED: '0',
    AUTONOMY_COLLECTIVE_SHADOW_PATH: latestPath,
    AUTONOMY_COLLECTIVE_SHADOW_MIN_CONFIDENCE: '0',
    AUTONOMY_COLLECTIVE_SHADOW_MAX_PENALTY: '20',
    AUTONOMY_COLLECTIVE_SHADOW_MAX_BONUS: '10'
  };
  const enabledController = loadController({
    ...baseEnv,
    AUTONOMY_COLLECTIVE_SHADOW_ENABLED: '1'
  });
  const disabledController = loadController({
    ...baseEnv,
    AUTONOMY_COLLECTIVE_SHADOW_ENABLED: '0'
  });

  const signal = enabledController.candidateCollectiveShadowSignal(candidate);
  assert.strictEqual(signal.applied, true, 'candidate should match collective shadow archetype');
  assert.ok(Number(signal.penalty || 0) > 0, 'collective shadow should produce penalty for failing archetype');

  const rankedWithShadow = enabledController.strategyRankForCandidate(candidate, null, { priorRuns: [] });
  const rankedWithoutShadow = disabledController.strategyRankForCandidate(candidate, null, { priorRuns: [] });
  assert.ok(
    Number(rankedWithShadow.score) < Number(rankedWithoutShadow.score),
    'collective shadow penalty should reduce strategy rank'
  );
  assert.ok(
    Number(rankedWithShadow.components.collective_shadow_penalty || 0) > 0,
    'strategy components should expose collective shadow penalty'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('collective_shadow.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`collective_shadow.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'outcome_fitness_loop.js');
  return spawnSync('node', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_outcome_fitness_loop');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const strategyDir = path.join(tmpRoot, 'config', 'strategies');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const receiptsDir = path.join(tmpRoot, 'state', 'autonomy', 'receipts');
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  const outDir = path.join(tmpRoot, 'state', 'adaptive', 'strategy');
  mkDir(strategyDir);
  mkDir(runsDir);
  mkDir(receiptsDir);
  mkDir(proposalsDir);

  const date = '2026-02-21';

  writeJson(path.join(strategyDir, 'default.json'), {
    version: '1.0',
    id: 'default_general',
    status: 'active',
    objective: { primary: 'test outcome fitness loop' },
    risk_policy: { allowed_risks: ['low'] },
    ranking_weights: {
      composite: 0.35,
      actionability: 0.2,
      directive_fit: 0.15,
      signal_quality: 0.15,
      expected_value: 0.1,
      time_to_value: 0,
      risk_penalty: 0.05
    },
    threshold_overrides: {
      min_directive_fit: 40,
      min_actionability_score: 45,
      min_composite_eligibility: 62
    }
  });

  writeJsonl(path.join(runsDir, `${date}.jsonl`), [
    {
      ts: `${date}T10:00:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'shipped',
      strategy_id: 'default_general',
      receipt_id: 'r1'
    },
    {
      ts: `${date}T11:00:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      outcome: 'no_change',
      strategy_id: 'default_general',
      receipt_id: 'r2'
    },
    {
      ts: `${date}T12:00:00.000Z`,
      type: 'autonomy_run',
      result: 'stop_repeat_gate_daily_cap',
      strategy_id: 'default_general'
    }
  ]);

  writeJsonl(path.join(receiptsDir, `${date}.jsonl`), [
    {
      ts: `${date}T10:05:00.000Z`,
      type: 'autonomy_action_receipt',
      receipt_id: 'r1',
      verdict: 'pass',
      receipt_contract: { attempted: true, verified: true },
      verification: { passed: true, outcome: 'shipped' }
    },
    {
      ts: `${date}T11:05:00.000Z`,
      type: 'autonomy_action_receipt',
      receipt_id: 'r2',
      verdict: 'fail',
      receipt_contract: { attempted: true, verified: false },
      verification: { passed: false, outcome: 'no_change' }
    }
  ]);

  writeJson(path.join(proposalsDir, `${date}.json`), [
    {
      id: 'P1',
      meta: {
        admission_preview: {
          eligible: false,
          blocked_by: ['directive_fit_low']
        }
      }
    }
  ]);

  const env = {
    ...process.env,
    AUTONOMY_STRATEGY_DIR: strategyDir,
    OUTCOME_FITNESS_RUNS_DIR: runsDir,
    OUTCOME_FITNESS_RECEIPTS_DIR: receiptsDir,
    OUTCOME_FITNESS_PROPOSALS_DIR: proposalsDir,
    OUTCOME_FITNESS_OUT_DIR: outDir
  };

  let r = runScript(repoRoot, ['run', date, '--days=1', '--apply=1'], env);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.applied, true);
  assert.ok(Number.isFinite(Number(out.realized_outcome_score)), 'realized_outcome_score should be numeric');
  assert.strictEqual(Number(out.proposal_filter_policy.min_success_criteria_count), 2, 'low verified rate should tighten criteria count');
  assert.strictEqual(Number(out.focus_policy.min_focus_score_delta), 3, 'directive-fit blocked dominance should tighten focus');
  assert.ok(fs.existsSync(path.join(outDir, 'outcome_fitness.json')), 'latest outcome fitness must persist');
  assert.ok(fs.existsSync(path.join(outDir, 'outcome_fitness', `${date}.json`)), 'history outcome fitness must persist');

  r = runScript(repoRoot, ['status', 'latest'], env);
  assert.strictEqual(r.status, 0, `status latest should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.path, path.join(outDir, 'outcome_fitness.json'));

  console.log('outcome_fitness_loop.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`outcome_fitness_loop.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'routing', 'router_budget_calibration.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(p, rows) {
  mkDir(path.dirname(p));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(p, body ? `${body}\n` : '', 'utf8');
}

function run(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJsonOut(r, label) {
  const line = String(r.stdout || '').split('\n').find((x) => x.trim().startsWith('{'));
  assert.ok(line, `${label}: expected JSON line on stdout, got: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line);
}

function buildFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-calibration-'));
  const configPath = path.join(root, 'config', 'agent_routing_rules.json');
  const stateDir = path.join(root, 'state', 'routing');
  const spendDir = path.join(stateDir, 'spend');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');

  writeJson(configPath, {
    version: 1,
    routing: {
      spawn_model_allowlist: ['ollama/qwen3:4b'],
      model_profiles: {
        'ollama/qwen3:4b': { class: 'cheap_local' }
      },
      router_budget_policy: {
        enabled: true,
        model_token_multipliers: {
          'ollama/qwen3:4b': 0.42
        }
      }
    }
  });

  const day = new Date().toISOString().slice(0, 10);
  writeJson(path.join(spendDir, `${day}.json`), {
    date: day,
    by_model: {
      'ollama/qwen3:4b': {
        requests: 18,
        request_tokens_est_total: 1800,
        model_tokens_est_total: 756
      }
    }
  });

  const runRows = [];
  for (let i = 0; i < 12; i++) {
    runRows.push({
      ts: `${day}T08:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      route_summary: {
        selected_model: 'ollama/qwen3:4b',
        cost_estimate: { selected_model_tokens_est: 42 }
      },
      token_usage: {
        actual_available: true,
        actual_total_tokens: 63,
        effective_tokens: 63
      }
    });
  }
  runRows.push({
    ts: `${day}T09:00:00.000Z`,
    type: 'autonomy_run',
    result: 'score_only_evidence',
    preview_summary: {
      selected_model: 'ollama/qwen3:4b',
      cost_estimate: { selected_model_tokens_est: 84 }
    },
    token_usage: {
      source: 'estimated_fallback',
      source_kind: 'estimated',
      actual_available: false,
      estimated_tokens: 84,
      effective_tokens: 84
    }
  });
  writeJsonl(path.join(runsDir, `${day}.jsonl`), runRows);

  return {
    root,
    configPath,
    stateDir,
    spendDir,
    runsDir
  };
}

function baseEnv(fix) {
  return {
    ROUTER_CONFIG_PATH: fix.configPath,
    ROUTER_STATE_DIR: fix.stateDir,
    ROUTER_SPEND_DIR: fix.spendDir,
    ROUTER_AUTONOMY_RUNS_DIR: fix.runsDir,
    ROUTER_CALIBRATION_SKIP_GUARD: '1'
  };
}

function main() {
  const fix = buildFixtureRoot();
  const env = baseEnv(fix);

  const report = run(['run', '--days=7', '--min-samples=8', '--min-requests=8'], env);
  assert.strictEqual(report.status, 0, `run failed: ${report.stderr}`);
  const reportJson = parseJsonOut(report, 'run');
  assert.strictEqual(reportJson.ok, true);
  assert.ok(Number(reportJson.telemetry && reportJson.telemetry.effective_samples_total || 0) >= 13, 'expected effective sample coverage');
  assert.ok(Number(reportJson.changed_models || 0) >= 1, 'expected at least one changed model recommendation');
  const row = (reportJson.recommendations || []).find((x) => x.model === 'ollama/qwen3:4b');
  assert.ok(row, 'missing qwen recommendation row');
  assert.ok(Number(row.proposed_multiplier) > Number(row.current_multiplier), 'expected upward multiplier calibration');

  const apply = run(['apply', '--days=7', '--min-samples=8', '--min-requests=8'], {
    ...env,
    CLEARANCE: '3'
  });
  assert.strictEqual(apply.status, 0, `apply failed: ${apply.stderr}`);
  const applyJson = parseJsonOut(apply, 'apply');
  assert.ok(applyJson.apply_result && applyJson.apply_result.ok === true, 'expected apply_result.ok=true');
  const updatedCfg = JSON.parse(fs.readFileSync(fix.configPath, 'utf8'));
  const updatedMultiplier = Number(
    updatedCfg.routing.router_budget_policy.model_token_multipliers['ollama/qwen3:4b']
  );
  assert.ok(updatedMultiplier > 0.42, `expected updated multiplier > 0.42, got ${updatedMultiplier}`);

  const rollback = run(['rollback', 'latest'], {
    ...env,
    CLEARANCE: '3'
  });
  assert.strictEqual(rollback.status, 0, `rollback failed: ${rollback.stderr}`);
  const rolledCfg = JSON.parse(fs.readFileSync(fix.configPath, 'utf8'));
  const rolledMultiplier = Number(
    rolledCfg.routing.router_budget_policy.model_token_multipliers['ollama/qwen3:4b']
  );
  assert.strictEqual(rolledMultiplier, 0.42, 'rollback should restore baseline multiplier');

  console.log('router_budget_calibration.test: OK');
}

main();

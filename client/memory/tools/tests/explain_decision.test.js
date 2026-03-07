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

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'ops', 'explain_decision.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-decision-'));
  const policyPath = path.join(tmp, 'config', 'explain_decision_policy.json');

  writeJson(path.join(tmp, 'state', 'execution', 'task_decomposition_primitive', 'latest.json'), {
    ok: true,
    type: 'task_decomposition_primitive',
    ts: '2026-02-28T00:00:00.000Z',
    run_id: 'tdp_test_001',
    shadow_only: true,
    goal: {
      goal_id: 'goal_test_1',
      goal_text: 'Prepare investor update memo',
      objective_id: 'obj_growth'
    },
    micro_tasks: [
      {
        task_text: 'Draft investor memo',
        governance: {
          blocked: false,
          block_reasons: [],
          heroic_echo: {
            decision: 'purified_and_amplified',
            reason_codes: ['sovereignty_guard_active']
          },
          constitution: {
            decision: 'ALLOW',
            reasons: ['No high-risk patterns detected']
          }
        },
        duality: {
          score_trit: 0,
          recommended_adjustment: 'introduce_balanced_order_and_flux'
        }
      }
    ],
    passport_id: 'passport_test_123'
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    max_reason_count: 4,
    paths: {
      latest_path: path.join(tmp, 'state', 'ops', 'explain_decision', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'explain_decision', 'receipts.jsonl')
    },
    sources: {
      task_decomposition: path.join(tmp, 'state', 'execution', 'task_decomposition_primitive', 'latest.json'),
      explanation: path.join(tmp, 'state', 'primitives', 'explanation_primitive', 'latest.json'),
      passport: path.join(tmp, 'state', 'security', 'agent_passport', 'latest.json'),
      duality: path.join(tmp, 'state', 'autonomy', 'duality', 'latest.json'),
      self_improvement: path.join(tmp, 'state', 'autonomy', 'gated_self_improvement', 'latest.json')
    }
  });

  const env = {
    ...process.env,
    EXPLAIN_DECISION_ROOT: tmp,
    EXPLAIN_DECISION_POLICY_PATH: policyPath
  };

  const explain = run(script, repoRoot, ['run', '--source=task_decomposition', '--decision-id=tdp_test_001', `--policy=${policyPath}`], env);
  assert.strictEqual(explain.status, 0, explain.stderr || 'run should pass');
  assert.ok(explain.payload && explain.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(String(explain.payload.source_id || ''), 'task_decomposition');
  assert.ok(String(explain.payload.plain_english || '').includes('shadow-only execution'), 'narrative should explain shadow mode');
  assert.ok(String(explain.payload.plain_english || '').includes('Duality balance'), 'narrative should include duality summary');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.counts && status.payload.counts.receipts || 0) >= 1, 'status should report receipts');

  console.log('explain_decision.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`explain_decision.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


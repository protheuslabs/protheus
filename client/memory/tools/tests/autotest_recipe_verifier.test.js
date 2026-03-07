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
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8'
  );
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  assert.ok(raw, 'expected stdout');
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('unable to parse json payload');
}

function runCli(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'ops', 'autotest_recipe_verifier.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-recipe-verifier-'));
  const policyPath = path.join(tmp, 'config', 'autotest_doctor_policy.json');
  const verifierStatePath = path.join(tmp, 'state', 'ops', 'autotest_doctor', 'recipe_verifier_state.json');
  const runsDir = path.join(tmp, 'state', 'ops', 'autotest', 'runs');

  writeJson(policyPath, {
    recipe_rollout: {
      verifier_state_path: verifierStatePath
    },
    recipes: [
      {
        id: 'retest_then_pulse',
        enabled: true,
        applies_to: ['assertion_failed', 'exit_nonzero'],
        steps: ['retest_failed_test', 'autotest_run_changed']
      }
    ]
  });

  writeJsonl(path.join(runsDir, '2026-02-27.jsonl'), [
    {
      type: 'autotest_run',
      ts: '2026-02-27T03:00:00.000Z',
      results: [
        {
          id: 'tst_1',
          command: 'node client/memory/tools/tests/autotest_recipe_verifier.test.js',
          guard_ok: true,
          ok: false,
          exit_code: 1,
          stderr_excerpt: 'assert failed'
        }
      ]
    }
  ]);

  const env = {
    ...process.env,
    AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR: runsDir
  };
  const r = runCli(scriptPath, ['run', '2026-02-27', `--policy=${policyPath}`], env, root);
  assert.strictEqual(r.status, 0, `verifier run should pass: ${r.stderr}`);
  const out = parsePayload(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.recipes_checked, 1);
  assert.strictEqual(out.recipes_passed, 1);
  assert.ok(fs.existsSync(verifierStatePath), 'verifier state should exist');

  const state = JSON.parse(fs.readFileSync(verifierStatePath, 'utf8'));
  assert.ok(state.recipes && state.recipes.retest_then_pulse && state.recipes.retest_then_pulse.ok === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('autotest_recipe_verifier.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autotest_recipe_verifier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


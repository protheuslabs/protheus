#!/usr/bin/env node
'use strict';
// SRS regression evidence anchor: V6-SWARM-032.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(
  ROOT,
  'client',
  'runtime',
  'systems',
  'autonomy',
  'swarm_orchestration_runtime.ts'
);

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runNode(args, env = {}) {
  return spawnSync(process.execPath, [WRAPPER].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-test-'));
  const fakeBin = path.join(tmpDir, 'protheus-ops');
  const testState = path.join(tmpDir, 'state.json');

  fs.writeFileSync(
    fakeBin,
    '#!/bin/sh\necho "{\\"error\\":\\"unknown_domain\\"}"\nexit 1\n',
    'utf8'
  );
  fs.chmodSync(fakeBin, 0o755);

  const statusRun = runNode(['status', `--state-path=${testState}`], {
    PROTHEUS_NPM_BINARY: fakeBin,
  });
  const stdout = String(statusRun.stdout || '');
  const stderr = String(statusRun.stderr || '');
  assert.strictEqual(
    statusRun.status,
    0,
    `status command should recover from unknown_domain binary; stderr=${stderr}\nstdout=${stdout}`
  );
  assert(
    stdout.includes('"type":"swarm_runtime_status"'),
    `expected swarm runtime status payload, got: ${stdout}`
  );

  const recursiveRun = runNode(['test', '--id=2', '--levels=3', `--state-path=${testState}`], {
    PROTHEUS_NPM_BINARY: fakeBin,
  });
  assert.strictEqual(
    recursiveRun.status,
    0,
    `recursive test must pass through fallback path; stderr=${recursiveRun.stderr}\nstdout=${recursiveRun.stdout}`
  );

  const budgetedRun = runNode(
    ['run', '--objective=budget-check', '--team_size=1', '--token-budget=500', `--state-path=${testState}`],
    {
      PROTHEUS_NPM_BINARY: fakeBin,
    }
  );
  assert.notStrictEqual(
    budgetedRun.status,
    0,
    `budgeted run should fail-closed on parent over-allocation; stderr=${budgetedRun.stderr}\nstdout=${budgetedRun.stdout}`
  );
  const payload = parseLastJson(budgetedRun.stdout);
  assert(payload && payload.ok === false, `expected fail-closed payload, got: ${budgetedRun.stdout}`);
  const errorText = String(payload && payload.error ? payload.error : '');
  assert(
    errorText.includes('parent_token_budget_exceeded') && errorText.includes('requested=500'),
    `expected parent budget enforcement error with requested=500, got: ${budgetedRun.stdout}`
  );
}

run();
console.log(
  JSON.stringify({
    ok: true,
    type: 'swarm_orchestration_runtime_test',
  })
);

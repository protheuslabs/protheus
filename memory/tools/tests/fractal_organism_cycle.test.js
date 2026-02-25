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
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'fractal', 'organism_cycle.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-organism-'));
  const dateStr = '2026-02-25';

  const fractalDir = path.join(tmpRoot, 'state', 'autonomy', 'fractal');
  const runsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const introspectionDir = path.join(fractalDir, 'introspection');
  const simDir = path.join(tmpRoot, 'state', 'autonomy', 'simulations');

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'build' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'optimize' },
    { type: 'autonomy_run', result: 'policy_hold', outcome: 'no_change', proposal_type: 'optimize' }
  ]);
  writeJson(path.join(introspectionDir, `${dateStr}.json`), {
    snapshot: {
      queue: { pressure: 'critical' },
      autopause: { active: false }
    },
    restructure_candidates: [{ id: 'c1' }]
  });
  writeJson(path.join(simDir, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.029 },
      yield_rate: { value: 0.69 }
    }
  });

  const env = {
    ...process.env,
    FRACTAL_ORGANISM_DIR: fractalDir,
    FRACTAL_ORGANISM_RUNS_DIR: runsDir,
    FRACTAL_INTROSPECTION_DIR: introspectionDir,
    FRACTAL_ORGANISM_SIM_DIR: simDir
  };

  const runProc = spawnSync(process.execPath, [scriptPath, 'run', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runProc.status, 0, runProc.stderr || 'run should pass');
  const runOut = JSON.parse(String(runProc.stdout || '{}').trim());
  assert.strictEqual(runOut.ok, true);
  assert.ok(Number(runOut.pheromones || 0) >= 1);
  assert.ok(Number(runOut.archetypes || 0) >= 1);

  const cyclePath = path.join(fractalDir, 'organism_cycle', `${dateStr}.json`);
  const cycle = JSON.parse(fs.readFileSync(cyclePath, 'utf8'));
  assert.strictEqual(cycle.ok, true);
  assert.strictEqual(cycle.proposal_only, true);
  assert.ok(Array.isArray(cycle.symbiosis_plans));
  assert.ok(Array.isArray(cycle.predator_prey.candidates));

  const statusProc = spawnSync(process.execPath, [scriptPath, 'status', dateStr], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = JSON.parse(String(statusProc.stdout || '{}').trim());
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.archetypes || 0) >= 1);

  console.log('fractal_organism_cycle.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`fractal_organism_cycle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

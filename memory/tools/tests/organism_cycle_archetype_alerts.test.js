#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'fractal', 'organism_cycle.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'organism-cycle-archetype-alerts-'));
  const fractalDir = path.join(tmp, 'fractal');
  const runsDir = path.join(tmp, 'runs');
  const simDir = path.join(tmp, 'sim');
  const introspectionDir = path.join(fractalDir, 'introspection');
  const dateStr = '2026-02-25';

  writeJsonl(path.join(runsDir, `${dateStr}.jsonl`), [
    { ts: `${dateStr}T01:00:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'shipped', proposal_type: 'unknown' },
    { ts: `${dateStr}T01:10:00.000Z`, type: 'autonomy_run', result: 'executed', outcome: 'no_change', proposal_type: 'unknown' },
    { ts: `${dateStr}T01:20:00.000Z`, type: 'autonomy_run', result: 'no_candidates_policy_manual_review_pending', proposal_type: 'unknown' }
  ]);
  writeJson(path.join(simDir, `${dateStr}.json`), {
    checks_effective: {
      drift_rate: { value: 0.028 },
      yield_rate: { value: 0.71 }
    }
  });
  writeJson(path.join(introspectionDir, `${dateStr}.json`), {
    snapshot: {
      queue: { pressure: 'normal' },
      autopause: { active: false }
    },
    restructure_candidates: []
  });

  const env = {
    FRACTAL_ORGANISM_DIR: fractalDir,
    FRACTAL_ORGANISM_RUNS_DIR: runsDir,
    FRACTAL_ORGANISM_SIM_DIR: simDir,
    FRACTAL_INTROSPECTION_DIR: introspectionDir
  };

  let r = runCmd(['run', dateStr], env);
  assert.strictEqual(r.status, 0, `first run should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true, 'first run should report ok');
  assert.strictEqual(out.archetype_novelty_alert, true, 'first run should trigger novelty alert');
  assert.ok(Number(out.archetype_new || 0) > 0, 'first run should report new archetypes');

  const alertPath = path.join(fractalDir, 'alerts', `${dateStr}.jsonl`);
  assert.ok(fs.existsSync(alertPath), 'novelty run should emit alert row');
  const firstAlerts = fs.readFileSync(alertPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(firstAlerts.length >= 1, 'alert log should contain at least one row after novelty');

  r = runCmd(['run', dateStr], env);
  assert.strictEqual(r.status, 0, `second run should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true, 'second run should report ok');
  assert.strictEqual(out.archetype_novelty_alert, false, 'second run with unchanged archetypes should not re-alert');

  const secondAlerts = fs.readFileSync(alertPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(secondAlerts.length, firstAlerts.length, 'non-novel repeat run should not append extra alert rows');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('organism_cycle_archetype_alerts.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`organism_cycle_archetype_alerts.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'strategy', 'weekly_executed_outcomes_synthesis.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-outcome-synth-'));
  const policyPath = path.join(tmp, 'config', 'weekly_executed_outcomes_synthesis_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    default_delta_step: 0.05,
    max_delta_abs: 0.2,
    outputs: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  const env = {
    WEEKLY_EXEC_OUTCOME_SYNTH_ROOT: tmp,
    WEEKLY_EXEC_OUTCOME_SYNTH_POLICY_PATH: policyPath
  };

  const rows = JSON.stringify([
    { strategy: 'growth', ok: true, revenue_delta: 200 },
    { strategy: 'growth', ok: true, revenue_delta: 80 },
    { strategy: 'stability', ok: false, revenue_delta: -50 },
    { strategy: 'stability', ok: false, revenue_delta: -20 }
  ]);

  const r = run(['run', `--rows-json=${rows}`, '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'run should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');

  const growth = out.recommendations.find((row) => row.strategy === 'growth');
  const stability = out.recommendations.find((row) => row.strategy === 'stability');
  assert.ok(growth && growth.recommended_weight_delta > 0, 'growth should have positive delta');
  assert.ok(stability && stability.recommended_weight_delta < 0, 'stability should have negative delta');

  console.log('weekly_executed_outcomes_synthesis.test.js: OK');
}

try { main(); } catch (err) { console.error(`weekly_executed_outcomes_synthesis.test.js: FAIL: ${err.message}`); process.exit(1); }

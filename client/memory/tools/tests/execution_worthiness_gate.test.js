#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'execution_worthiness_gate.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-worthiness-'));
  const policyPath = path.join(tmp, 'config', 'execution_worthiness_gate_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    threshold: 0.75,
    outputs: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  const env = {
    EXEC_WORTHINESS_GATE_ROOT: tmp,
    EXEC_WORTHINESS_GATE_POLICY_PATH: policyPath
  };

  const strong = JSON.stringify({
    id: 'p_good',
    objective_id: 'T1_GROWTH',
    action_spec: {
      command: 'node client/systems/ops/do.js run',
      verify: { command: 'node client/systems/ops/do.js verify' },
      rollback: { command: 'node client/systems/ops/do.js rollback' }
    }
  });

  let r = run(['score', `--proposal-json=${strong}`, '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'strong proposal should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'strong payload should pass');

  const weak = JSON.stringify({ id: 'p_weak', action_spec: {} });
  r = run(['score', `--proposal-json=${weak}`, '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'weak proposal should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false && Array.isArray(out.blockers) && out.blockers.length >= 1, 'weak payload should include blockers');

  console.log('execution_worthiness_gate.test.js: OK');
}

try { main(); } catch (err) { console.error(`execution_worthiness_gate.test.js: FAIL: ${err.message}`); process.exit(1); }

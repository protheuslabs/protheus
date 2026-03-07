#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'routing', 'task_type_outcome_learning.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-type-outcome-'));
  const policyPath = path.join(tmp, 'config', 'task_type_outcome_learning_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    smoothing: {
      beta_prior_success: 1,
      beta_prior_failure: 1,
      min_samples_for_strong_bias: 3
    },
    outputs: {
      matrix_path: path.join(tmp, 'state', 'routing', 'matrix.json'),
      latest_path: path.join(tmp, 'state', 'routing', 'latest.json'),
      history_path: path.join(tmp, 'state', 'routing', 'history.jsonl')
    }
  });

  const env = {
    TASK_TYPE_OUTCOME_LEARNING_ROOT: tmp,
    TASK_TYPE_OUTCOME_LEARNING_POLICY_PATH: policyPath
  };

  let r = run(['ingest', '--rows-json=[{"task_type":"research","model":"deepthinker","ok":true},{"task_type":"research","model":"smallthinker","ok":false},{"task_type":"research","model":"deepthinker","ok":true}]', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'ingest should pass');

  r = run(['rank', '--task-type=research', '--candidates=smallthinker,deepthinker', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'rank should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'rank payload should be ok');
  assert.strictEqual(out.selected_model, 'deepthinker', 'deepthinker should rank first');

  console.log('task_type_outcome_learning.test.js: OK');
}

try { main(); } catch (err) { console.error(`task_type_outcome_learning.test.js: FAIL: ${err.message}`); process.exit(1); }

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'science', 'hypothesis_forge.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  write(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-forge-'));
  const policyPath = path.join(tmp, 'config', 'hypothesis_forge_policy.json');
  const latestPath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'history.jsonl');
  const rankedPath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'ranked.json');
  const pendingPath = path.join(tmp, 'state', 'science', 'hypothesis_forge', 'pending_signals.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    require_consent: true,
    paths: {
      pending_signals_path: pendingPath,
      latest_path: latestPath,
      history_path: historyPath,
      ranked_path: rankedPath
    }
  });

  writeJsonl(pendingPath, [
    { id: 'a', signal: 'Revenue signal divergence', prior: 0.7, voi: 0.9, disconfirm_value: 0.8, risk: 0.2 },
    { id: 'b', signal: 'Low-value housekeeping', prior: 0.5, voi: 0.2, disconfirm_value: 0.2, risk: 0.1 }
  ]);

  const env = {
    HYPOTHESIS_FORGE_ROOT: tmp,
    HYPOTHESIS_FORGE_POLICY_PATH: policyPath
  };

  let out = run(['tick', '--consent=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'tick should pass with consent');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'tick payload should be ok');
  assert.strictEqual(Number(payload.count || 0), 2, 'tick should rank two hypotheses');
  assert.ok(Array.isArray(payload.ranked) && payload.ranked[0].id === 'a', 'higher VOI hypothesis should rank first');

  out = run(['rank', '--consent=0', '--hypotheses-json=[]'], env);
  assert.strictEqual(out.status, 1, 'rank should fail without consent when required');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false && payload.error === 'consent_required', 'consent gate should block');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');

  console.log('hypothesis_forge.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`hypothesis_forge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

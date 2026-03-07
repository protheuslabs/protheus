#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'swarm_verification_mode.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

function parseJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-verify-'));
  const policyPath = path.join(tmp, 'config', 'swarm_verification_mode_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    quorum: { min_votes: 3, min_agreement_ratio: 0.66, min_avg_confidence: 0.6 },
    budget: { max_tokens_per_verification: 1000 },
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'swarm', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'swarm', 'history.jsonl')
    }
  });
  const env = { SWARM_VERIFY_ROOT: tmp, SWARM_VERIFY_POLICY_PATH: policyPath };

  let r = run(['verify', '--strict=1', '--tokens=200', '--proposal-json={"id":"p1"}', '--votes-json=[{"model":"a","verdict":"approve","confidence":0.9},{"model":"b","verdict":"approve","confidence":0.8},{"model":"c","verdict":"reject","confidence":0.7}]'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'valid quorum should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');

  r = run(['verify', '--strict=1', '--tokens=2000', '--proposal-json={"id":"p2"}', '--votes-json=[{"model":"a","verdict":"approve","confidence":0.9},{"model":"b","verdict":"approve","confidence":0.8},{"model":"c","verdict":"approve","confidence":0.7}]'], env);
  assert.notStrictEqual(r.status, 0, 'token budget breach should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.blockers.some((b) => b.gate === 'budget'));

  console.log('swarm_verification_mode.test.js: OK');
}

try { main(); } catch (err) { console.error(`swarm_verification_mode.test.js: FAIL: ${err.message}`); process.exit(1); }

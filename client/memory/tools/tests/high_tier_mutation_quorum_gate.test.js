#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'high_tier_mutation_quorum_gate.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'high-tier-quorum-'));
  const policyPath = path.join(tmp, 'config', 'high_tier_mutation_quorum_gate_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    high_tiers: ['identity', 'constitution'],
    require_explanation_on_disagreement: true,
    outputs: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  const env = {
    HIGH_TIER_MUTATION_QUORUM_GATE_ROOT: tmp,
    HIGH_TIER_MUTATION_QUORUM_GATE_POLICY_PATH: policyPath
  };

  let r = run(['validate', '--proposal-json={"id":"m1","tier":"identity"}', '--primary-json={"agree":true}', '--secondary-json={"agree":true}', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'agreement should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass on agreement');

  r = run(['validate', '--proposal-json={"id":"m2","tier":"identity"}', '--primary-json={"agree":true}', '--secondary-json={"agree":false}', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'disagreement should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === false && Array.isArray(out.blockers) && out.blockers.length >= 1, 'payload should include blockers');

  console.log('high_tier_mutation_quorum_gate.test.js: OK');
}

try { main(); } catch (err) { console.error(`high_tier_mutation_quorum_gate.test.js: FAIL: ${err.message}`); process.exit(1); }

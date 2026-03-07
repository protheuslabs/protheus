#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'continuity', 'active_state_continuity_layer.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) {
  const t = String(stdout || '').trim(); if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-layer-'));
  const policyPath = path.join(tmp, 'config', 'active_state_continuity_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    lease_ttl_sec: 300,
    redact_keys: ['token', 'secret', 'api_key'],
    outputs: {
      state_path: path.join(tmp, 'state', 'continuity', 'state.json'),
      latest_path: path.join(tmp, 'state', 'continuity', 'latest.json'),
      history_path: path.join(tmp, 'state', 'continuity', 'history.jsonl')
    }
  });
  const env = { ACTIVE_STATE_CONTINUITY_ROOT: tmp, ACTIVE_STATE_CONTINUITY_POLICY_PATH: policyPath };

  let r = run(['lease-acquire', '--device=macbook', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'lease acquire should pass');

  r = run(['checkpoint', '--device=macbook', '--state-json={"cursor":5,"api_key":"secret123"}', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'checkpoint should pass');

  r = run(['replay', '--to-device=ipad', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'replay should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.checkpoint && out.checkpoint.payload && out.checkpoint.payload.api_key === '[REDACTED]', 'replay payload must redact secrets');

  console.log('active_state_continuity_layer.test.js: OK');
}

try { main(); } catch (err) { console.error(`active_state_continuity_layer.test.js: FAIL: ${err.message}`); process.exit(1); }

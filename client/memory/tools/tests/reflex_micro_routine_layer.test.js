#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'reflex', 'reflex_micro_routine_layer.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-micro-'));
  const policyPath = path.join(tmp, 'config', 'reflex_micro_routine_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    route: {
      min_confidence_for_reflex: 0.8,
      max_latency_ms_for_reflex: 1000,
      reflex_allowed_task_tokens: ['check']
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'reflex', 'latest.json'),
      history_path: path.join(tmp, 'state', 'reflex', 'history.jsonl')
    }
  });
  const env = { REFLEX_MICRO_LAYER_ROOT: tmp, REFLEX_MICRO_LAYER_POLICY_PATH: policyPath };

  let r = run(['route', '--strict=1', '--task=run check command', '--confidence=0.9', '--latency-ms=200'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'eligible reflex route should pass');
  let out = parseJson(r.stdout);
  assert.strictEqual(out.route, 'reflex');

  r = run(['route', '--strict=1', '--task=run check command', '--confidence=0.3', '--latency-ms=200'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'habit fallback should still pass');
  out = parseJson(r.stdout);
  assert.strictEqual(out.route, 'habit');
  assert.strictEqual(out.reason, 'confidence_below_reflex_threshold');

  console.log('reflex_micro_routine_layer.test.js: OK');
}

try { main(); } catch (err) { console.error(`reflex_micro_routine_layer.test.js: FAIL: ${err.message}`); process.exit(1); }

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'memory', 'memory_fallback_retirement_gate.js');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, payload) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runCmd(policyPath, args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_FALLBACK_RETIREMENT_POLICY_PATH: policyPath
    }
  });
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   MEMORY FALLBACK RETIREMENT GATE TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('evaluate denies JS fallback when retired and no emergency toggle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-fallback-gate-'));
  const policyPath = path.join(root, 'config', 'memory_fallback_retirement_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    allow_js_fallback: false,
    paths: {
      emergency_toggle_path: path.join(root, 'state', 'toggle.json'),
      latest_path: path.join(root, 'state', 'latest.json'),
      receipts_path: path.join(root, 'state', 'receipts.jsonl')
    }
  });

  const r = runCmd(policyPath, ['evaluate', '--operation=query', '--backend_requested=rust', '--fallback_reason=rust_crate_missing']);
  assert.strictEqual(r.status, 2, `expected deny status: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'expected ok=false');
  assert.strictEqual(out.allow, false);
  assert.strictEqual(out.decision_reason, 'js_fallback_retired');
});

runTest('enable-emergency allows fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-fallback-gate-'));
  const policyPath = path.join(root, 'config', 'memory_fallback_retirement_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    allow_js_fallback: false,
    paths: {
      emergency_toggle_path: path.join(root, 'state', 'toggle.json'),
      latest_path: path.join(root, 'state', 'latest.json'),
      receipts_path: path.join(root, 'state', 'receipts.jsonl')
    }
  });

  const enable = runCmd(policyPath, ['enable-emergency', '--reason=test_emergency']);
  assert.strictEqual(enable.status, 0, `enable-emergency failed: ${enable.stderr}`);
  const e = parseJson(enable.stdout);
  assert.ok(e && e.emergency_toggle && e.emergency_toggle.active === true, 'expected active emergency toggle');

  const evalRes = runCmd(policyPath, ['evaluate', '--operation=get', '--backend_requested=rust', '--fallback_reason=rust_daemon_down']);
  assert.strictEqual(evalRes.status, 0, `expected allow status: ${evalRes.stderr}`);
  const out = parseJson(evalRes.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(out.allow, true);
  assert.strictEqual(out.decision_reason, 'emergency_toggle_active');
});

if (failed) process.exit(1);
console.log('✅ memory_fallback_retirement_gate tests passed');

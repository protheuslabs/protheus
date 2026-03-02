#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'governance_hardening_pack.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-hardening-'));
  const immutableA = path.join(tmp, 'config', 'caps.json');
  const immutableB = path.join(tmp, 'systems', 'security', 'kernel.ts');
  writeText(immutableA, '{"a":1}\n');
  writeText(immutableB, 'export const kernel = true;\n');

  const policyPath = path.join(tmp, 'config', 'governance_hardening_pack_policy.json');
  const baselinePath = path.join(tmp, 'state', 'security', 'governance_hardening_pack', 'baseline.json');
  const emergencyPath = path.join(tmp, 'state', 'security', 'governance_hardening_pack', 'emergency_stop.json');
  const latestPath = path.join(tmp, 'state', 'security', 'governance_hardening_pack', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'security', 'governance_hardening_pack', 'history.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    escalation_target_modes: ['execute'],
    dual_control: { required_approvals: 2, require_distinct: true },
    caps: { max_daily_usd: 10, max_risk_score: 0.6 },
    immutable_files: ['config/caps.json', 'systems/security/kernel.ts'],
    immutable_baseline_path: baselinePath,
    emergency_stop_path: emergencyPath,
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    GOV_HARDENING_ROOT: tmp,
    GOV_HARDENING_POLICY_PATH: policyPath
  };

  let r = run(['refresh-baseline', '--apply=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'refresh-baseline should pass');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.strictEqual(baseline['config/caps.json'], sha256(immutableA), 'baseline hash should be recorded');

  r = run(['evaluate', '--strict=1', '--target-mode=execute', '--approval=alice', '--daily-usd=2', '--risk-score=0.2'], env);
  assert.notStrictEqual(r.status, 0, 'single approval should fail dual-control gate');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail');
  assert.ok(Array.isArray(out.blockers) && out.blockers.some((b) => b.gate === 'dual_control'));

  r = run([
    'evaluate', '--strict=1', '--target-mode=execute', '--approval=alice', '--approval=bob', '--daily-usd=11', '--risk-score=0.2'
  ], env);
  assert.notStrictEqual(r.status, 0, 'daily cap breach should fail');
  out = parseJson(r.stdout);
  assert.ok(Array.isArray(out.blockers) && out.blockers.some((b) => b.gate === 'budget_cap'));

  r = run([
    'evaluate', '--strict=1', '--target-mode=execute', '--approval=alice', '--approval=bob', '--daily-usd=4', '--risk-score=0.2'
  ], env);
  assert.strictEqual(r.status, 0, r.stderr || 'valid evaluate should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'valid payload should be ok');

  r = run(['emergency-stop', '--apply=1', '--reason=test_stop'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'emergency-stop should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.emergency_stop && out.emergency_stop.active === true, 'emergency stop should be active');
  assert.ok(fs.existsSync(emergencyPath), 'emergency stop file should exist');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'status should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status payload should be ok');

  console.log('governance_hardening_pack.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`governance_hardening_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

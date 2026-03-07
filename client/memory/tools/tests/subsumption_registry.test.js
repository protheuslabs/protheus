#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runCmd(scriptPath, argv, opts = {}) {
  return spawnSync(process.execPath, [scriptPath].concat(argv || []), {
    encoding: 'utf8',
    ...opts
  });
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'eye', 'subsumption_registry.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subsumption-registry-test-'));
  const policyPath = path.join(tmp, 'config', 'subsumption_adapter_policy.json');
  const statePath = path.join(tmp, 'state', 'eye', 'subsumption_registry_state.json');
  const auditPath = path.join(tmp, 'state', 'eye', 'audit', 'subsumption_registry.jsonl');
  const latestPath = path.join(tmp, 'state', 'eye', 'subsumption_latest.json');
  const day = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0',
    min_trust_allow: 0.7,
    min_trust_escalate: 0.45,
    global_daily_tokens: 120,
    providers: {
      alpha: {
        enabled: true,
        adapter: 'alpha.v1',
        trust_score: 0.82,
        min_trust: 0.72,
        daily_tokens: 80
      }
    }
  });

  const call = (argv) => runCmd(scriptPath, argv.concat([
    `--policy=${policyPath}`,
    `--state=${statePath}`,
    `--audit=${auditPath}`,
    `--latest=${latestPath}`,
    `--date=${day}`
  ]), { cwd: root });

  let r = call(['register', '--provider=beta', '--adapter=beta.v1', '--trust=0.60', '--min-trust=0.65', '--daily-tokens=60', '--enabled=1', '--apply=1']);
  assert.strictEqual(r.status, 0, `register should pass: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'register output should be ok');

  r = call(['evaluate', '--provider=beta', '--estimated-tokens=10', '--risk=low', '--apply=1']);
  assert.strictEqual(r.status, 0, `evaluate (escalate) should pass with exit 0: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.decision === 'escalate', 'beta should escalate with trust 0.60');

  r = call(['register', '--provider=beta', '--trust=0.85', '--daily-tokens=40', '--enabled=1', '--apply=1']);
  assert.strictEqual(r.status, 0, `trust uplift register should pass: ${r.stderr}`);

  r = call(['evaluate', '--provider=beta', '--estimated-tokens=30', '--risk=low', '--apply=1']);
  assert.strictEqual(r.status, 0, `allow evaluate should pass: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.decision === 'allow', 'beta should allow after trust uplift');

  r = call(['evaluate', '--provider=beta', '--estimated-tokens=20', '--risk=low', '--apply=1']);
  assert.strictEqual(r.status, 1, 'provider daily budget overflow should deny');
  out = parsePayload(r.stdout);
  assert.ok(Array.isArray(out.reasons) && out.reasons.includes('provider_daily_budget_exceeded'), 'deny should include provider budget reason');

  r = call(['disable', '--provider=beta', '--approval-note=disable for rollback safety', '--reason=test_disable', '--apply=1']);
  assert.strictEqual(r.status, 0, `disable should pass: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.enabled === false, 'disable should set enabled false');

  r = call(['evaluate', '--provider=beta', '--estimated-tokens=1', '--risk=low', '--apply=1']);
  assert.strictEqual(r.status, 1, 'disabled provider should deny');
  out = parsePayload(r.stdout);
  assert.ok(Array.isArray(out.reasons) && out.reasons.includes('provider_disabled'), 'deny should include provider_disabled');

  const statusRes = call(['status']);
  assert.strictEqual(statusRes.status, 0, `status should pass: ${statusRes.stderr}`);
  const statusOut = parsePayload(statusRes.stdout);
  assert.ok(statusOut && statusOut.ok === true, 'status output should be ok');
  assert.strictEqual(Number(statusOut.day_state.providers.beta.allow || 0), 1, 'beta allow count should be 1');
  assert.strictEqual(Number(statusOut.day_state.providers.beta.escalate || 0), 1, 'beta escalate count should be 1');
  assert.strictEqual(Number(statusOut.day_state.providers.beta.deny || 0), 2, 'beta deny count should be 2');
  assert.ok(fs.existsSync(auditPath), 'audit log should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('subsumption_registry.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`subsumption_registry.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


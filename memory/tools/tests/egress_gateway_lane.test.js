#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'egress_gateway.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    payload: parseJson(out.stdout),
    stderr: String(out.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-gateway-lane-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state.json');
  const auditPath = path.join(tmp, 'audit.jsonl');
  writeJson(policyPath, {
    version: '1.0-test',
    default_decision: 'deny',
    global_rate_caps: { per_hour: 10, per_day: 20 },
    scopes: {
      'lane.scope': {
        methods: ['GET'],
        domains: ['example.com'],
        rate_caps: { per_hour: 2, per_day: 3 }
      }
    }
  });
  const env = {
    EGRESS_GATEWAY_POLICY_PATH: policyPath,
    EGRESS_GATEWAY_STATE_PATH: statePath,
    EGRESS_GATEWAY_AUDIT_PATH: auditPath
  };

  let out = run(['authorize', '--scope=lane.scope', '--url=https://api.example.com/health', '--method=GET', '--caller=test', '--apply=1'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.allow === true, 'allowlisted request should pass');

  out = run(['authorize', '--scope=lane.scope', '--url=https://blocked.example.net', '--method=GET', '--caller=test', '--apply=0'], env);
  assert.strictEqual(out.status, 1, out.stderr);
  assert.ok(out.payload && out.payload.reason === 'domain_not_allowlisted', 'blocked domain should fail closed');

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.payload && out.payload.type === 'egress_gateway_status', 'status command should return status payload');
  assert.ok(out.payload.state && out.payload.state.per_hour, 'status should include state counters');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('egress_gateway_lane.test.js: OK');
} catch (err) {
  console.error(`egress_gateway_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

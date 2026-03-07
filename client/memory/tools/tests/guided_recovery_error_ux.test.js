#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'guided_recovery_error_ux.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-recovery-'));
  const policyPath = path.join(tmp, 'config', 'guided_recovery_error_ux_policy.json');
  const catalogPath = path.join(tmp, 'config', 'guided_recovery_error_catalog.json');
  const flagsPath = path.join(tmp, 'config', 'feature_flags.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'guided_recovery_error_ux', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'guided_recovery_error_ux', 'history.jsonl');

  writeJson(catalogPath, {
    version: '1.0-test',
    codes: {
      integration_gates_failed: { message: 'a', suggestions: ['s1'], troubleshoot_command: 'cmd1' },
      scientific_loop_failed: { message: 'b', suggestions: ['s1'], troubleshoot_command: 'cmd2' },
      channel_revoked: { message: 'c', suggestions: ['s1'], troubleshoot_command: 'cmd3' },
      approval_required_for_risk_tier: { message: 'd', suggestions: ['s1'], troubleshoot_command: 'cmd4' },
      root_surface_contract_failed: { message: 'e', suggestions: ['s1'], troubleshoot_command: 'cmd5' }
    }
  });

  writeJson(flagsPath, { guided_recovery_ux: false });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    feature_flag_name: 'guided_recovery_ux',
    feature_flag_default: false,
    catalog_path: catalogPath,
    required_reason_codes: [
      'integration_gates_failed',
      'scientific_loop_failed',
      'channel_revoked',
      'approval_required_for_risk_tier',
      'root_surface_contract_failed'
    ],
    paths: {
      feature_flags_path: flagsPath,
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass with complete catalog');

  out = run(['explain', '--reason=channel_revoked', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.known_code, true, 'known code should resolve');

  out = run(['explain', '--reason=unknown_code', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.known_code, false, 'unknown code should use fallback explainer');

  out = run(['enable', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, true, 'enable should set flag');

  out = run(['disable', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.enabled, false, 'disable should clear flag');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('guided_recovery_error_ux.test.js: OK');
} catch (err) {
  console.error(`guided_recovery_error_ux.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'symbiosis', 'pre_neuralink_interface.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-neuralink-'));
  const policyPath = path.join(tmp, 'config', 'pre_neuralink_interface_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    local_first: true,
    require_explicit_consent: true,
    channels: ['voice', 'attention', 'haptic'],
    consent: {
      default_state: 'paused',
      allowed_states: ['granted', 'paused', 'revoked'],
      route_allowed_states: ['granted'],
      min_signal_confidence: 0.45
    },
    routing: {
      lane: 'organ',
      target: 'symbiosis',
      action_by_intent: {
        execute: 'execute',
        plan: 'plan',
        reflect: 'observe',
        support: 'observe'
      },
      risk_by_intent: {
        execute: 'medium',
        plan: 'low',
        reflect: 'low',
        support: 'low'
      },
      default_estimated_tokens: 100
    },
    handoff_contract: {
      version: '1.0',
      modality_family: 'non_invasive',
      compatible_future_interfaces: ['bci', 'neural_link'],
      path: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'handoff_contract.json')
    },
    paths: {
      state: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'state.json'),
      latest: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'latest.json'),
      signals: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'signals.jsonl'),
      routes: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'routes.jsonl'),
      receipts: path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    PRE_NEURALINK_POLICY_PATH: policyPath,
    PRE_NEURALINK_MOCK_EYE_DECISION: 'allow'
  };

  const ingestPaused = run(script, repoRoot, [
    'ingest',
    '--channel=voice',
    '--signal=plan next 90 days',
    '--consent-state=paused',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(ingestPaused.status, 0, ingestPaused.stderr || 'ingest paused should pass');
  assert.ok(ingestPaused.payload && ingestPaused.payload.ok === true, 'ingest paused payload should be ok');

  const routePaused = run(script, repoRoot, [
    'route',
    '--apply=0',
    `--policy=${policyPath}`
  ], env);
  assert.notStrictEqual(routePaused.status, 0, 'route should fail when consent is paused');
  assert.ok(routePaused.payload && routePaused.payload.ok === false, 'route paused payload should fail');
  assert.ok(Array.isArray(routePaused.payload.blocked_reasons) && routePaused.payload.blocked_reasons.includes('consent_not_granted'), 'route should block on consent');

  const ingestGranted = run(script, repoRoot, [
    'ingest',
    '--channel=voice',
    '--signal=execute account setup task',
    '--consent-state=granted',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(ingestGranted.status, 0, ingestGranted.stderr || 'ingest granted should pass');

  const routeGranted = run(script, repoRoot, [
    'route',
    '--apply=0',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(routeGranted.status, 0, routeGranted.stderr || 'route granted should pass');
  assert.ok(routeGranted.payload && routeGranted.payload.ok === true, 'route granted payload should pass');
  assert.strictEqual(String(routeGranted.payload.decision || ''), 'allow', 'decision should be allow');

  const handoff = run(script, repoRoot, [
    'handoff-contract',
    '--write=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(handoff.status, 0, handoff.stderr || 'handoff should pass');
  assert.ok(handoff.payload && handoff.payload.ok === true, 'handoff payload should be ok');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'symbiosis', 'pre_neuralink_interface', 'handoff_contract.json')), 'handoff contract should be written');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(String(status.payload.consent_state || ''), 'granted', 'status should reflect consent');

  console.log('pre_neuralink_interface.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`pre_neuralink_interface.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

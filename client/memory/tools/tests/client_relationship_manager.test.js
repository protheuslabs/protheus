#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'workflow', 'client_relationship_manager.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-relationship-manager-'));
  const policyPath = path.join(tmp, 'client_relationship_manager_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    qualified_case_tiers: ['standard', 'high', 'strategic'],
    event_types: ['negotiation', 'scope_change', 'dispute', 'repeat_business'],
    require_workflow_ref_for_auto: true,
    manual_intervention_target: 0.05,
    sla_hours_by_type: {
      negotiation: 24,
      scope_change: 12,
      dispute: 4,
      repeat_business: 24
    },
    state_path: path.join(tmp, 'state', 'workflow', 'client_relationship_manager', 'state.json'),
    latest_path: path.join(tmp, 'state', 'workflow', 'client_relationship_manager', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'workflow', 'client_relationship_manager', 'receipts.jsonl')
  });
  const env = { CLIENT_RELATIONSHIP_MANAGER_POLICY_PATH: policyPath };

  const openRes = run(['case-open', '--case-id=case_a', '--client-id=client_a', '--channel=email', '--tier=standard'], env);
  assert.strictEqual(openRes.status, 0, openRes.stderr || 'case-open should pass');
  const openPayload = parseJson(openRes.stdout);
  assert.ok(openPayload && openPayload.ok === true, 'case-open payload should be ok');

  const failAuto = run(['event', '--case-id=case_a', '--type=negotiation', '--handled-by=auto'], env);
  assert.notStrictEqual(failAuto.status, 0, 'auto event without workflow id should fail');
  const failPayload = parseJson(failAuto.stdout);
  assert.strictEqual(failPayload.error, 'workflow_id_required_for_auto');

  const eventRes = run(['event', '--case-id=case_a', '--type=negotiation', '--handled-by=auto', '--workflow-id=wf_001'], env);
  assert.strictEqual(eventRes.status, 0, eventRes.stderr || 'event should pass');
  const eventPayload = parseJson(eventRes.stdout);
  assert.ok(eventPayload && eventPayload.ok === true, 'event payload should be ok');
  assert.strictEqual(eventPayload.event.handled_by, 'auto');

  const evalRes = run(['evaluate', '--days=30', '--strict=1'], env);
  assert.strictEqual(evalRes.status, 0, evalRes.stderr || 'evaluate should pass strict');
  const evalPayload = parseJson(evalRes.stdout);
  assert.ok(evalPayload && evalPayload.ok === true, 'evaluate payload should pass');
  assert.strictEqual(evalPayload.metrics.manual_rate, 0, 'manual rate should be zero');

  const statusRes = run(['status', '--days=30'], env);
  assert.strictEqual(statusRes.status, 0, statusRes.stderr || 'status should pass');
  const statusPayload = parseJson(statusRes.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Number(statusPayload.total_cases || 0) >= 1, 'should have at least one case');

  console.log('client_relationship_manager.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`client_relationship_manager.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

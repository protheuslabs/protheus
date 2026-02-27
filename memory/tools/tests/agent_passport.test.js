#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { writeContractReceipt } = require('../../../lib/action_receipts.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected json stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'security', 'agent_passport.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-passport-'));

  const stateRoot = path.join(tmp, 'state', 'security', 'agent_passport');
  const policyPath = path.join(tmp, 'config', 'agent_passport_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    auto_link_from_receipts: true,
    auto_issue_passport: true,
    require_active_passport: false,
    key_env: 'AGENT_PASSPORT_SIGNING_KEY',
    passport_ttl_hours: 48,
    actor_defaults: {
      actor_id: 'jay',
      role: 'owner',
      tenant_id: 'prime',
      org_id: 'openclaw',
      framework_id: 'protheus',
      model_id: 'left_brain'
    },
    state: {
      root: stateRoot,
      passport_path: path.join(stateRoot, 'passport.json'),
      action_log_path: path.join(stateRoot, 'actions.jsonl'),
      chain_state_path: path.join(stateRoot, 'actions.chain.json'),
      latest_path: path.join(stateRoot, 'latest.json'),
      receipts_path: path.join(stateRoot, 'receipts.jsonl')
    },
    pdf: {
      default_out_path: path.join(stateRoot, 'exports', 'latest_passport.pdf'),
      max_rows: 1000
    }
  });

  const env = {
    ...process.env,
    AGENT_PASSPORT_POLICY_PATH: policyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent-passport-test-key-1234567890',
    AGENT_PASSPORT_AUTOLINK: '1'
  };
  process.env.AGENT_PASSPORT_POLICY_PATH = policyPath;
  process.env.AGENT_PASSPORT_SIGNING_KEY = 'agent-passport-test-key-1234567890';
  process.env.AGENT_PASSPORT_AUTOLINK = '1';

  const issue = runNode(script, [
    'issue',
    '--actor=jay',
    '--role=owner',
    '--tenant=prime',
    '--framework=protheus',
    '--model=left_brain',
    '--org=openclaw'
  ], env, repoRoot);
  assert.strictEqual(issue.status, 0, issue.stderr || issue.stdout);
  const issueOut = parseJson(issue, 'issue');
  assert.strictEqual(issueOut.ok, true);

  const receiptPath = path.join(tmp, 'receipts.jsonl');
  writeContractReceipt(receiptPath, {
    type: 'autonomy_action_receipt',
    objective: 'ship_audit_ready_lane',
    receipt_id: 'receipt_1',
    status: 'ok'
  }, { attempted: true, verified: true });

  const actionsPath = path.join(stateRoot, 'actions.jsonl');
  const actions = readJsonl(actionsPath);
  assert.strictEqual(actions.length, 1, 'auto-link should append one passport action');
  assert.strictEqual(actions[0].actor.actor_id, 'jay');
  assert.strictEqual(actions[0].actor.tenant_id, 'prime');
  assert.strictEqual(actions[0].action.receipt_path, receiptPath);
  assert.strictEqual(actions[0].action.verified, true);

  const verify = runNode(script, ['verify', '--strict=1'], env, repoRoot);
  assert.strictEqual(verify.status, 0, verify.stderr || verify.stdout);
  const verifyOut = parseJson(verify, 'verify');
  assert.strictEqual(verifyOut.ok, true);
  assert.strictEqual(Number(verifyOut.rows || 0), 1);

  const exportPdfPath = path.join(tmp, 'passport.pdf');
  const exp = runNode(script, ['export-pdf', `--out=${exportPdfPath}`], env, repoRoot);
  assert.strictEqual(exp.status, 0, exp.stderr || exp.stdout);
  const expOut = parseJson(exp, 'export');
  assert.strictEqual(expOut.ok, true);
  assert.ok(fs.existsSync(exportPdfPath), 'pdf export should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AGENT_PASSPORT_POLICY_PATH;
  delete process.env.AGENT_PASSPORT_SIGNING_KEY;
  delete process.env.AGENT_PASSPORT_AUTOLINK;
  console.log('agent_passport.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`agent_passport.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

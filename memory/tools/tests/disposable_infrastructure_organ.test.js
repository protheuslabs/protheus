#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function run(scriptPath, args, env, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
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
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'actuation', 'disposable_infrastructure_organ.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disposable-infra-'));
  const policyPath = path.join(tmp, 'policy.json');
  const statePath = path.join(tmp, 'state.json');
  const latestPath = path.join(tmp, 'latest.json');
  const receiptsPath = path.join(tmp, 'receipts.jsonl');
  const sessionsPath = path.join(tmp, 'sessions.jsonl');
  const dncPath = path.join(tmp, 'do_not_contact.json');

  writeJson(dncPath, ['blocked@example.com']);
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    compliance: {
      enforce_can_spam: true,
      enforce_opt_out_footer: true,
      enforce_identity_disclosure: true,
      do_not_contact_path: dncPath
    },
    risk: {
      max_daily_sends_per_account: 10,
      rotate_on_bounce_rate: 0.08,
      rotate_on_block_score: 0.7,
      min_reputation_for_send: 0.4
    },
    pools: {
      accounts: {
        max_active: 5,
        providers_allowed: ['gmail', 'outlook'],
        warmup_days_min: 3
      },
      proxies: {
        max_active: 5,
        providers_allowed: ['residential_pool']
      }
    },
    state: {
      state_path: statePath,
      latest_path: latestPath,
      receipts_path: receiptsPath,
      sessions_path: sessionsPath
    }
  });

  const env = {
    ...process.env,
    DISPOSABLE_INFRASTRUCTURE_POLICY_PATH: policyPath
  };

  let out = run(scriptPath, [
    'register-account',
    '--account-id=acct_1',
    '--provider=gmail',
    '--warmup-days=10',
    '--reputation=0.74',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'register-account should pass');
  assert.ok(out.payload && out.payload.ok === true, 'register-account payload should be ok');
  assert.strictEqual(Boolean(out.payload.apply_allowed), false, 'shadow policy should keep apply disallowed');

  out = run(scriptPath, [
    'register-proxy',
    '--proxy-id=proxy_1',
    '--provider=residential_pool',
    '--region=us',
    '--quality-score=0.81',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'register-proxy should pass');
  assert.ok(out.payload && out.payload.ok === true, 'register-proxy payload should be ok');

  out = run(scriptPath, [
    'acquire-session',
    '--task-id=campaign_1_lead_1',
    '--risk-class=medium',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'acquire-session should pass');
  assert.ok(out.payload && out.payload.ok === true, 'acquire-session payload should be ok');
  assert.ok(out.payload.session && out.payload.session.session_id, 'session id should be emitted');
  assert.strictEqual(String(out.payload.autonomy_contract && out.payload.autonomy_contract.risk_tier || ''), 'medium', 'session should carry medium tier autonomy');
  assert.strictEqual(Boolean(out.payload.autonomy_contract && out.payload.autonomy_contract.operator_prompt_required), false, 'medium tier should not require operator prompt');
  const sessionId = String(out.payload.session.session_id || '');

  out = run(scriptPath, [
    'report-deliverability',
    `--session-id=${sessionId}`,
    '--bounce-rate=0.11',
    '--block-score=0.2',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'report-deliverability should pass');
  assert.ok(out.payload && out.payload.rotate_recommended === true, 'high bounce should trigger rotation recommendation');

  out = run(scriptPath, [
    'release-session',
    `--session-id=${sessionId}`,
    '--reason=test_complete',
    '--apply=0'
  ], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'release-session should pass');
  assert.ok(out.payload && out.payload.session && String(out.payload.session.status || '').includes('released'), 'session should move to released state');

  out = run(scriptPath, ['status'], env, root);
  assert.strictEqual(out.status, 0, out.stderr || 'status should pass');
  assert.ok(out.payload && out.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Number(out.payload.pools.accounts_total || 0), 1, 'status should report one account');
  assert.strictEqual(Number(out.payload.pools.proxies_total || 0), 1, 'status should report one proxy');

  assert.ok(fs.existsSync(statePath), 'state path should exist');
  assert.ok(fs.existsSync(latestPath), 'latest path should exist');
  assert.ok(fs.existsSync(receiptsPath), 'receipts path should exist');
  assert.ok(fs.existsSync(sessionsPath), 'sessions path should exist');

  console.log('disposable_infrastructure_organ.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`disposable_infrastructure_organ.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

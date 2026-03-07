#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'signal_slo_deadlock_breaker.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function run(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected JSON output');
  return JSON.parse(txt);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-slo-deadlock-'));
  const proposalsDir = path.join(tmp, 'proposals');
  const queueLogPath = path.join(tmp, 'queue_log.jsonl');
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'policy.json');
  const sloStubPath = path.join(tmp, 'slo_stub.js');
  const date = '2026-02-26';

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    streak_threshold: 2,
    max_open_escalations: 1,
    lookback_days: 14,
    default_objective_id: 'T1_generational_wealth_v1',
    proposal: { type: 'infrastructure_outage', risk: 'medium', source: 'test', quality_gate: 'test' }
  });

  fs.writeFileSync(queueLogPath, [
    JSON.stringify({ ts: `${date}T00:00:00.000Z`, type: 'proposal_filtered', filter_reason: 'adaptive_mutation_missing_safety_attestation' }),
    JSON.stringify({ ts: `${date}T00:01:00.000Z`, type: 'proposal_filtered', filter_reason: 'adaptive_mutation_missing_safety_attestation' }),
    JSON.stringify({ ts: `${date}T00:02:00.000Z`, type: 'proposal_filtered', filter_reason: 'objective_missing' })
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(
    sloStubPath,
    `#!/usr/bin/env node
const mode=String(process.env.SLO_STUB_MODE||'fail');
if(mode==='pass'){console.log(JSON.stringify({ok:true,checks:{accepted_items:{ok:true}},failed_checks:[]}));process.exit(0);}
console.log(JSON.stringify({ok:false,checks:{accepted_items:{ok:false}},failed_checks:['accepted_items']}));process.exit(0);
`,
    'utf8'
  );
  fs.chmodSync(sloStubPath, 0o755);

  const env = {
    SIGNAL_SLO_DEADLOCK_POLICY_PATH: policyPath,
    SIGNAL_SLO_DEADLOCK_STATE_DIR: stateDir,
    SIGNAL_SLO_DEADLOCK_QUEUE_LOG_PATH: queueLogPath,
    SIGNAL_SLO_DEADLOCK_PROPOSALS_DIR: proposalsDir,
    SIGNAL_SLO_DEADLOCK_SLO_SCRIPT: sloStubPath
  };

  let res = run(['run', date], { ...env, SLO_STUB_MODE: 'fail' });
  assert.strictEqual(res.status, 0, `run fail-1 exited ${res.status}: ${res.stderr}`);
  let out = parseJson(res.stdout);
  assert.strictEqual(out.signal_slo_ok, false, 'first run should fail slo');
  assert.strictEqual(out.streak, 1, 'first fail should set streak=1');
  assert.ok(!out.escalation || out.escalation.created !== true, 'no escalation expected at streak=1');

  res = run(['run', date], { ...env, SLO_STUB_MODE: 'fail' });
  assert.strictEqual(res.status, 0, `run fail-2 exited ${res.status}: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.streak, 1, 'same-date rerun should keep streak stable');

  // next date fail pushes streak over threshold and should escalate
  const date2 = '2026-02-27';
  res = run(['run', date2], { ...env, SLO_STUB_MODE: 'fail' });
  assert.strictEqual(res.status, 0, `run fail-3 exited ${res.status}: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.streak >= 2, true, 'third fail should cross threshold');
  assert.ok(out.escalation && out.escalation.created === true, 'escalation proposal should be created');

  const proposalFile = path.join(proposalsDir, `${date2}.json`);
  const proposals = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  assert.ok(Array.isArray(proposals) && proposals.length > 0, 'proposal file should contain escalation');
  const p = proposals.find((row) => String(row.id || '') === String(out.escalation.proposal_id || ''));
  assert.ok(p, 'escalation proposal id should be present');
  assert.strictEqual(String(p.type || ''), 'infrastructure_outage');

  res = run(['run', '2026-02-28'], { ...env, SLO_STUB_MODE: 'pass' });
  assert.strictEqual(res.status, 0, `run pass exited ${res.status}: ${res.stderr}`);
  out = parseJson(res.stdout);
  assert.strictEqual(out.signal_slo_ok, true, 'pass run should be healthy');
  assert.strictEqual(out.streak, 0, 'pass run should reset streak');
  assert.ok(out.closure_receipt && out.closure_receipt.type === 'signal_slo_deadlock_closed', 'closure receipt should be emitted');

  console.log('signal_slo_deadlock_breaker.test.js: OK');
}

main();


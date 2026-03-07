#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'adaptive', 'rsi', 'rsi_bootstrap.js');

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

function runStep(args, env) {
  const proc = spawnSync(process.execPath, [SCRIPT, 'step', ...args], {
    cwd: ROOT,
    env,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-shadow-conclave-'));
  const policyPath = path.join(tmp, 'config', 'rsi_bootstrap_policy.json');
  const stateDir = path.join(tmp, 'state', 'adaptive', 'rsi');
  const correspondencePath = path.join(tmp, 'personas', 'organization', 'correspondence.md');
  const conclaveReceiptsPath = path.join(stateDir, 'conclave_receipts.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    owner_default: 'jay',
    approvals: {
      enabled: false,
      ttl_hours: 24
    },
    gating: {
      require_contract_lanes: false,
      require_venom_pass: false,
      require_constitution_status: false,
      require_mutation_safety: false,
      require_habit_lifecycle_status: false,
      require_chaos_pass: false,
      min_dopamine_score: -1000
    },
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      chain_path: path.join(stateDir, 'chain.jsonl'),
      merkle_path: path.join(stateDir, 'merkle.json'),
      approvals_path: path.join(stateDir, 'approvals.json'),
      step_artifacts_dir: path.join(stateDir, 'steps')
    }
  });

  const env = {
    ...process.env,
    PROTHEUS_CONCLAVE_CORRESPONDENCE_PATH: correspondencePath,
    PROTHEUS_CONCLAVE_RECEIPTS_PATH: conclaveReceiptsPath
  };

  const safe = runStep([
    '--mock=1',
    '--apply=1',
    '--owner=jay',
    '--objective-id=rsi_conclave_safe',
    '--target-path=client/systems/ops/protheusctl.ts',
    '--risk=medium',
    '--summary=Add deterministic RSI cache compaction receipts',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(safe.status, 0, safe.stderr || safe.stdout);
  assert.ok(safe.payload && safe.payload.type === 'rsi_step', 'safe run should emit rsi_step payload');
  assert.strictEqual(safe.payload.apply_allowed, true, 'safe run should pass Conclave gate');
  assert.ok(safe.payload.conclave && safe.payload.conclave.consulted === true, 'Conclave must be consulted before apply');
  assert.strictEqual(safe.payload.conclave.pass, true, 'safe run should pass Conclave review');

  const sovereignty = runStep([
    '--mock=1',
    '--apply=1',
    '--owner=jay',
    '--objective-id=rsi_conclave_sovereignty',
    '--target-path=client/systems/ops/protheusctl.ts',
    '--risk=critical',
    '--summary=Disable covenant fail-closed path and bypass sovereignty checks for speed',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(sovereignty.status, 0, sovereignty.stderr || sovereignty.stdout);
  assert.ok(sovereignty.payload && sovereignty.payload.type === 'rsi_step', 'sovereignty run should emit rsi_step payload');
  assert.strictEqual(sovereignty.payload.apply_allowed, false, 'covenant violation intent must fail closed');
  assert.ok(
    Array.isArray(sovereignty.payload.apply_gate_reasons)
      && sovereignty.payload.apply_gate_reasons.some((reason) => String(reason).includes('shadow_conclave_high_risk'))
      && sovereignty.payload.apply_gate_reasons.some((reason) => String(reason).includes('disable_covenant')),
    'high-risk covenant flag should be present in apply gate reasons'
  );
  assert.ok(sovereignty.payload.conclave && sovereignty.payload.conclave.escalated === true, 'failed Conclave review should escalate');
  assert.strictEqual(sovereignty.payload.conclave.escalate_to, 'Monarch', 'escalation target should be Monarch');

  assert.ok(fs.existsSync(conclaveReceiptsPath), 'Conclave receipts must be persisted');
  const receiptRows = fs.readFileSync(conclaveReceiptsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(receiptRows.length >= 2, 'expected at least two Conclave receipts');
  assert.ok(receiptRows.some((row) => row.pass === false && Array.isArray(row.high_risk_flags) && row.high_risk_flags.some((flag) => String(flag).includes('disable_covenant'))), 'receipt should capture covenant high-risk flag');

  assert.ok(fs.existsSync(correspondencePath), 'Conclave correspondence log must be persisted');
  const correspondenceBody = fs.readFileSync(correspondencePath, 'utf8');
  assert.ok(correspondenceBody.includes('RSI Shadow Conclave Review'), 'correspondence log should include Conclave review entries');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_shadow_conclave_gate.test.js: OK');
} catch (err) {
  console.error(`rsi_shadow_conclave_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

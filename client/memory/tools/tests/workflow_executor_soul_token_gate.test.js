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
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const executorScript = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-soul-gate-'));
  const dateStr = '2026-02-26';

  const policyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const soulPolicyPath = path.join(tmp, 'config', 'soul_token_guard_policy.json');
  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const latestLivePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest_live.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const receiptPath = path.join(tmp, 'state', 'receipts', 'workflow_receipt.json');

  writeJson(policyPath, {
    version: '1.0-test',
    rollout: {
      enabled: false
    },
    security_gates: {
      soul_token: {
        enabled: true,
        enforce_shadow_on_violation: true,
        strict_verify: false,
        timeout_ms: 8000,
        script: path.join(root, 'systems', 'security', 'soul_token_guard.js')
      }
    }
  });

  writeJson(soulPolicyPath, {
    version: '1.0-test',
    enabled: true,
    enforcement_mode: 'enforced',
    bind_to_fingerprint: true,
    key_env: 'SOUL_TOKEN_GUARD_KEY',
    token_state_path: path.join(tmp, 'state', 'security', 'soul_token_guard.json'),
    audit_path: path.join(tmp, 'state', 'security', 'soul_token_guard_audit.jsonl'),
    attestation_path: path.join(tmp, 'state', 'security', 'release_attestations.jsonl'),
    black_box_attestation_dir: path.join(tmp, 'state', 'security', 'black_box_ledger', 'attestations')
  });

  const workflow = {
    id: 'wf_soul_gate',
    name: 'Soul Gate Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-26T00:00:00.000Z',
    steps: [
      {
        id: 'prepare',
        type: 'command',
        command: `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').mkdirSync(require('path').dirname(${JSON.stringify(receiptPath)}), { recursive: true }); require('fs').writeFileSync(${JSON.stringify(receiptPath)}, 'ok\\n');`)}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'gate',
        type: 'gate',
        command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(0)')}`,
        retries: 0,
        timeout_ms: 30000
      },
      {
        id: 'receipt',
        type: 'receipt',
        command: receiptPath,
        retries: 0,
        timeout_ms: 30000
      }
    ]
  };
  writeJson(registryPath, {
    version: '1.0',
    workflows: [workflow]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_LATEST_LIVE_PATH: latestLivePath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath,
    SOUL_TOKEN_GUARD_POLICY_PATH: soulPolicyPath,
    SOUL_TOKEN_GUARD_KEY: 'test_soul_token_guard_key',
    SOUL_TOKEN_GUARD_FINGERPRINT: 'fp_soul_gate_test'
  };

  const runRes = spawnSync(process.execPath, [
    executorScript,
    'run',
    dateStr,
    '--dry-run=0',
    '--max=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(runRes.status, 0, runRes.stderr || 'workflow executor run should return payload');
  const payload = parsePayload(runRes.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should be ok');
  assert.strictEqual(payload.dry_run, true, 'soul token enforced violation should force dry-run');
  assert.strictEqual(payload.forced_shadow_soul_token, true, 'forced shadow flag should be set by soul-token gate');
  assert.ok(payload.soul_token_gate && payload.soul_token_gate.forced_shadow === true, 'soul token gate summary should indicate forced shadow');
  assert.ok(payload.soul_token_gate && payload.soul_token_gate.reason === 'token_missing', 'missing token should be surfaced');
  assert.strictEqual(fs.existsSync(receiptPath), false, 'forced dry-run should skip command execution and not write receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('workflow_executor_soul_token_gate.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor_soul_token_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
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

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mutation-gate-'));
  const dateStr = '2026-02-26';

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const latestLivePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest_live.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
  const policyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const toolsDir = path.join(tmp, 'tools');
  const failOnceScript = path.join(toolsDir, 'fail_once_then_pass.js');
  const writeReceiptScript = path.join(toolsDir, 'write_receipt.js');
  const failMarker = path.join(tmp, 'state', 'tmp', 'marker.txt');
  const receiptPath = path.join(tmp, 'state', 'receipts', `${dateStr}.jsonl`);

  writeText(
    failOnceScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const marker = String(process.argv[2] || '');",
      "if (!marker) process.exit(2);",
      "if (fs.existsSync(marker)) process.exit(0);",
      "fs.mkdirSync(path.dirname(marker), { recursive: true });",
      "fs.writeFileSync(marker, 'first_fail\\n', 'utf8');",
      'process.exit(9);'
    ].join('\n')
  );
  writeText(
    writeReceiptScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const out = String(process.argv[2] || '');",
      "if (!out) process.exit(2);",
      "fs.mkdirSync(path.dirname(out), { recursive: true });",
      "fs.writeFileSync(out, JSON.stringify({ ok: true, ts: new Date().toISOString() }) + '\\n', 'utf8');"
    ].join('\n')
  );

  writeJson(policyPath, {
    version: '1.0-test',
    security_gates: {
      soul_token: {
        enabled: false
      }
    },
    token_economics: {
      enabled: false,
      use_system_budget: false,
      run_token_cap: 0,
      fallback_run_token_cap: 0,
      defer_queue_enabled: false
    },
    runtime_mutation: {
      enabled: true,
      max_mutations_per_run: 4,
      max_mutations_per_workflow: 2,
      retry_after_apply: true,
      rollback_on_regression: true,
      max_retry_increment: 1,
      max_total_retry_per_step: 3,
      veto_window_sec: 0,
      require_safety_attestation: true,
      require_human_veto_for_high_impact: false,
      high_impact_levels: ['high', 'critical'],
      max_attempts_per_kind: 3,
      allow: {
        guard_hardening: false,
        rollback_path: false,
        retry_tuning: true
      }
    }
  });

  writeJson(registryPath, {
    version: '1.0',
    workflows: [
      {
        id: 'wf_mut_gate',
        name: 'Mutation Gate Workflow',
        status: 'active',
        source: 'test',
        updated_at: '2026-02-26T00:00:00.000Z',
        risk: 'medium',
        steps: [
          {
            id: 'unstable',
            type: 'command',
            command: `${shellQuote(process.execPath)} ${shellQuote(failOnceScript)} ${shellQuote(failMarker)}`,
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
            id: 'write_receipt',
            type: 'command',
            command: `${shellQuote(process.execPath)} ${shellQuote(writeReceiptScript)} ${shellQuote(receiptPath)}`,
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
      }
    ]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_LATEST_LIVE_PATH: latestLivePath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath,
    WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR: stepReceiptsDir,
    WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR: mutationReceiptsDir,
    WORKFLOW_EXECUTOR_CWD: tmp
  };

  const blockedRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--id=wf_mut_gate',
    '--runtime-mutation=1',
    '--dry-run=0',
    '--receipt-strict=0',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.ok([0, 1].includes(blockedRun.status), `blocked run should return payload (status=${blockedRun.status}): ${blockedRun.stderr || blockedRun.stdout}`);
  const blockedOut = parsePayload(blockedRun.stdout);
  assert.ok(
    blockedOut && blockedOut.ok === true,
    `blocked run payload should be returned stdout=${String(blockedRun.stdout || '').slice(0, 800)} stderr=${String(blockedRun.stderr || '').slice(0, 800)}`
  );
  assert.strictEqual(
    Number(blockedOut.workflows_failed || 0),
    1,
    `without safety attestation, workflow should fail payload=${JSON.stringify(blockedOut)}`
  );
  assert.strictEqual(Number(blockedOut.runtime_mutations_applied || 0), 0, 'mutation should not apply when gate blocks');

  const mutationReceiptPath = path.join(mutationReceiptsDir, `${dateStr}.jsonl`);
  const blockedRows = fs.existsSync(mutationReceiptPath)
    ? fs.readFileSync(mutationReceiptPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.ok(
    blockedRows.some((row) => row && row.status === 'blocked' && String(row.reason || '').includes('missing_safety_attestation')),
    'mutation receipts should include missing_safety_attestation block reason'
  );

  if (fs.existsSync(failMarker)) fs.unlinkSync(failMarker);

  const allowedRun = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    '--id=wf_mut_gate',
    '--runtime-mutation=1',
    '--runtime-mutation-safety-attested=1',
    '--dry-run=0',
    '--receipt-strict=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.ok([0, 1].includes(allowedRun.status), `allowed run should return payload (status=${allowedRun.status}): ${allowedRun.stderr || allowedRun.stdout}`);
  const allowedOut = parsePayload(allowedRun.stdout);
  assert.ok(allowedOut && allowedOut.ok === true, 'allowed run payload should be returned');
  assert.strictEqual(Number(allowedOut.workflows_succeeded || 0), 1, 'safety-attested mutation run should succeed');
  assert.ok(Number(allowedOut.runtime_mutations_applied || 0) >= 1, 'mutation should apply once attested');
}

run();

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
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assimilation-usage-integration-'));
  const dateStr = '2026-02-26';

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
  const toolsDir = path.join(tmp, 'tools');
  const writerScript = path.join(toolsDir, 'write_receipt.js');
  const receiptPath = path.join(tmp, 'state', 'autonomy', 'receipts', `${dateStr}.jsonl`);
  const policyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const ledgerPath = path.join(tmp, 'state', 'assimilation', 'ledger.json');

  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    writerScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const p = String(process.argv[2] || '');",
      "if (!p) process.exit(2);",
      "fs.mkdirSync(require('path').dirname(p), { recursive: true });",
      "fs.writeFileSync(p, JSON.stringify({ ok: true, ts: new Date().toISOString() }) + '\\n', 'utf8');"
    ].join('\n'),
    'utf8'
  );

  writeJson(policyPath, {
    version: '1.0',
    runtime_mutation: {
      enabled: false
    },
    token_economics: {
      enabled: false
    }
  });

  const workflow = {
    id: 'wf_assimilation_usage',
    name: 'Assimilation Usage Workflow',
    status: 'active',
    source: 'test',
    updated_at: '2026-02-26T00:00:00.000Z',
    metadata: {
      adapter: 'stripe'
    },
    steps: [
      {
        id: 'prepare',
        type: 'command',
        command: `${shellQuote(process.execPath)} ${shellQuote(writerScript)} ${shellQuote(receiptPath)}`,
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
    updated_at: null,
    generated_at: null,
    workflows: [workflow]
  });

  const env = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath,
    WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR: stepReceiptsDir,
    WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR: mutationReceiptsDir,
    WORKFLOW_EXECUTOR_CWD: tmp,
    ASSIMILATION_LEDGER_PATH: ledgerPath
  };

  const runProc = spawnSync(process.execPath, [
    scriptPath,
    'run',
    dateStr,
    `--policy=${policyPath}`,
    '--max=3',
    '--dry-run=0',
    '--include-draft=0',
    '--receipt-strict=1',
    '--enforce-eligibility=0'
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });

  assert.strictEqual(runProc.status, 0, runProc.stderr || runProc.stdout);
  const out = parsePayload(runProc.stdout);
  assert.ok(out && out.ok === true, 'executor run should succeed');
  assert.ok(out.assimilation_usage && out.assimilation_usage.enabled === true, 'assimilation usage summary should be present');
  assert.ok(Number(out.assimilation_usage.recorded || 0) >= 1, 'usage rows should be recorded');
  assert.ok(fs.existsSync(ledgerPath), 'assimilation ledger should be persisted');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.ok(ledger && ledger.capabilities && ledger.capabilities['adapter:stripe'], 'adapter capability should be tracked');
  assert.ok(Number(ledger.capabilities['adapter:stripe'].uses_total || 0) >= 1);

  console.log('assimilation_usage_integration.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`assimilation_usage_integration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

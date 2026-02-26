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

function issueLease(root, env, scope, target) {
  const scriptPath = path.join(root, 'systems', 'security', 'capability_lease.js');
  const r = spawnSync(process.execPath, [
    scriptPath,
    'issue',
    `--scope=${scope}`,
    `--target=${target}`,
    '--ttl-sec=900',
    '--issued-by=workflow_executor_external_ring_test',
    '--reason=authorize external workflow execution'
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.strictEqual(r.status, 0, `lease issue should pass: ${r.stderr}`);
  const out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'lease issue payload should be ok');
  assert.ok(String(out.token || '').length > 20, 'lease token should be returned');
  return String(out.token);
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const executorPath = path.join(root, 'systems', 'workflow', 'workflow_executor.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-external-ring-'));
  fs.mkdirSync(path.join(root, 'state', 'tmp'), { recursive: true });
  const localAdapterRoot = fs.mkdtempSync(path.join(root, 'state', 'tmp', 'wf-external-ring-adapter-'));
  const dateStr = '2026-02-26';

  const adapterModulePath = path.join(localAdapterRoot, 'mock_ext_adapter.js');
  const adapterConfigPath = path.join(tmp, 'config', 'actuation_adapters.json');
  const clawPolicyPath = path.join(tmp, 'config', 'actuation_claws_policy.json');
  const workflowPolicyPath = path.join(tmp, 'config', 'workflow_executor_policy.json');
  const eyePolicyPath = path.join(tmp, 'config', 'eye_kernel_policy.json');
  const eyeStatePath = path.join(tmp, 'state', 'eye', 'control_plane_state.json');
  const eyeAuditPath = path.join(tmp, 'state', 'eye', 'audit', 'command_bus.jsonl');
  const eyeLatestPath = path.join(tmp, 'state', 'eye', 'latest.json');
  const subsumptionPolicyPath = path.join(tmp, 'config', 'subsumption_adapter_policy.json');
  const subsumptionStatePath = path.join(tmp, 'state', 'eye', 'subsumption_registry_state.json');
  const subsumptionAuditPath = path.join(tmp, 'state', 'eye', 'audit', 'subsumption_registry.jsonl');
  const subsumptionLatestPath = path.join(tmp, 'state', 'eye', 'subsumption_latest.json');
  const policyRootAuditPath = path.join(tmp, 'state', 'security', 'policy_root_decisions.jsonl');
  const capabilityLeaseStatePath = path.join(tmp, 'state', 'security', 'capability_leases.json');
  const capabilityLeaseAuditPath = path.join(tmp, 'state', 'security', 'capability_leases.jsonl');
  const actuationReceiptsDir = path.join(tmp, 'state', 'actuation', 'receipts');

  const registryPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'registry.json');
  const runsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'runs');
  const historyPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'history.jsonl');
  const latestPath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const rolloutStatePath = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'rollout_state.json');
  const stepReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'step_receipts');
  const mutationReceiptsDir = path.join(tmp, 'state', 'adaptive', 'workflows', 'executor', 'mutations');
  const expectedActuationReceiptPath = path.join(actuationReceiptsDir, `${dateStr}.jsonl`);

  fs.mkdirSync(path.dirname(adapterModulePath), { recursive: true });
  fs.writeFileSync(
    adapterModulePath,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      'module.exports = {',
      '  execute: async ({ dryRun }) => ({',
      '    ok: true,',
      '    code: 0,',
      '    summary: {',
      "      decision: 'ACTUATE',",
      "      gate_decision: 'ALLOW',",
      '      executable: dryRun !== true,',
      "      adapter: 'mock_ext',",
      '      verified: true',
      '    },',
      "    details: { bridge: 'mock_ext_adapter' }",
      '  })',
      '};'
    ].join('\n'),
    'utf8'
  );

  writeJson(adapterConfigPath, {
    adapters: {
      mock_ext: {
        module: path.relative(root, adapterModulePath).replace(/\\/g, '/'),
        description: 'mock external adapter'
      }
    }
  });
  writeJson(clawPolicyPath, {
    version: '1.0',
    enabled: true,
    default_lane: 'api',
    adapter_lane_map: {
      mock_ext: 'api'
    },
    lanes: {
      api: { mode: 'active', require_human_approval: false }
    }
  });
  writeJson(workflowPolicyPath, {
    version: '1.0',
    execution_gate: {
      enabled: true,
      min_steps: 2,
      require_gate_step: false,
      require_receipt_step: true,
      require_concrete_commands: true,
      require_rollback_path: false,
      allow_policy_default_rollback: true,
      min_composite_score: 0
    },
    rollout: {
      enabled: false
    },
    external_orchestration: {
      enabled: true,
      detect_actuation_commands: true,
      command_pattern: 'systems/actuation/actuation_executor.js',
      require_policy_root_for_live: true,
      allow_dry_run_without_policy_root: true,
      policy_root_scope: 'workflow_external_orchestration',
      policy_root_source: 'workflow_executor_test',
      eye_lane: 'vassal',
      eye_action: 'execute',
      eye_clearance: 'L2',
      risk_default: 'medium',
      require_subsumption_allow: true,
      allow_escalate_decision: false,
      estimated_tokens_default: 20,
      default_provider: 'mock_provider'
    }
  });
  writeJson(eyePolicyPath, {
    version: '1.0',
    default_decision: 'deny',
    clearance_levels: ['L0', 'L1', 'L2', 'L3'],
    risk: {
      escalate: [],
      deny: ['critical']
    },
    budgets: {
      global_daily_tokens: 10000
    },
    lanes: {
      vassal: {
        enabled: true,
        min_clearance: 'L2',
        daily_tokens: 5000,
        actions: ['execute'],
        targets: ['mock_provider']
      }
    }
  });
  writeJson(subsumptionPolicyPath, {
    version: '1.0',
    min_trust_allow: 0.7,
    min_trust_escalate: 0.45,
    global_daily_tokens: 10000,
    providers: {
      mock_provider: {
        enabled: true,
        adapter: 'mock_ext',
        trust_score: 0.9,
        min_trust: 0.7,
        daily_tokens: 5000
      }
    }
  });

  const workflowBase = {
    id: 'wf_external_ring',
    name: 'External Ring Workflow',
    status: 'active',
    source: 'test',
    objective_id: 'obj_external_ring',
    updated_at: '2026-02-26T00:00:00.000Z',
    metadata: {
      adapter: 'mock_ext',
      provider: 'mock_provider'
    }
  };

  function writeWorkflow(executeCommand) {
    writeJson(registryPath, {
      version: '1.0',
      updated_at: null,
      generated_at: null,
      workflows: [{
        ...workflowBase,
        steps: [
          {
            id: 'execute_external',
            type: 'external',
            adapter: 'mock_ext',
            provider: 'mock_provider',
            risk: 'medium',
            clearance: 'L2',
            estimated_tokens: 20,
            require_policy_root: true,
            command: executeCommand,
            retries: 0,
            timeout_ms: 120000
          },
          {
            id: 'receipt',
            type: 'receipt',
            command: expectedActuationReceiptPath,
            retries: 0,
            timeout_ms: 30000
          }
        ]
      }]
    });
  }

  const baseEnv = {
    ...process.env,
    WORKFLOW_REGISTRY_PATH: registryPath,
    WORKFLOW_EXECUTOR_POLICY_PATH: workflowPolicyPath,
    WORKFLOW_EXECUTOR_RUNS_DIR: runsDir,
    WORKFLOW_EXECUTOR_HISTORY_PATH: historyPath,
    WORKFLOW_EXECUTOR_LATEST_PATH: latestPath,
    WORKFLOW_EXECUTOR_ROLLOUT_STATE_PATH: rolloutStatePath,
    WORKFLOW_EXECUTOR_STEP_RECEIPTS_DIR: stepReceiptsDir,
    WORKFLOW_EXECUTOR_MUTATION_RECEIPTS_DIR: mutationReceiptsDir,
    WORKFLOW_EXECUTOR_CWD: root,
    WORKFLOW_EXECUTOR_EYE_POLICY_PATH: eyePolicyPath,
    WORKFLOW_EXECUTOR_EYE_STATE_PATH: eyeStatePath,
    WORKFLOW_EXECUTOR_EYE_AUDIT_PATH: eyeAuditPath,
    WORKFLOW_EXECUTOR_EYE_LATEST_PATH: eyeLatestPath,
    WORKFLOW_EXECUTOR_SUBSUMPTION_POLICY_PATH: subsumptionPolicyPath,
    WORKFLOW_EXECUTOR_SUBSUMPTION_STATE_PATH: subsumptionStatePath,
    WORKFLOW_EXECUTOR_SUBSUMPTION_AUDIT_PATH: subsumptionAuditPath,
    WORKFLOW_EXECUTOR_SUBSUMPTION_LATEST_PATH: subsumptionLatestPath,
    ACTUATION_ADAPTERS_CONFIG: adapterConfigPath,
    ACTUATION_CLAWS_POLICY_PATH: clawPolicyPath,
    ACTUATION_RECEIPTS_DIR: actuationReceiptsDir,
    POLICY_ROOT_AUDIT_PATH: policyRootAuditPath,
    CAPABILITY_LEASE_KEY: 'wf_external_ring_test_secret',
    CAPABILITY_LEASE_STATE_PATH: capabilityLeaseStatePath,
    CAPABILITY_LEASE_AUDIT_PATH: capabilityLeaseAuditPath
  };

  const runExecutor = (extraArgs = [], env = baseEnv) => spawnSync(process.execPath, [
    executorPath,
    'run',
    dateStr,
    '--max=2',
    '--include-draft=0',
    '--continue-on-error=1',
    '--runtime-mutation=0',
    '--enforce-eligibility=1',
    ...extraArgs
  ], {
    cwd: root,
    encoding: 'utf8',
    env
  });

  writeWorkflow('node systems/actuation/actuation_executor.js run --kind=<adapter> --dry-run');
  let r = runExecutor(['--dry-run=1']);
  assert.strictEqual(r.status, 0, `dry-run external workflow should pass: ${r.stderr}`);
  let out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'dry-run payload should be ok');
  assert.strictEqual(
    Number(out.workflows_succeeded || 0),
    1,
    `dry-run should not require policy root lease: ${JSON.stringify(out)}`
  );

  writeWorkflow('node systems/actuation/actuation_executor.js run --kind=<adapter>');
  r = runExecutor(['--dry-run=0']);
  assert.strictEqual(r.status, 0, `live external run should return payload even when blocked: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'live payload should be ok envelope');
  assert.strictEqual(Number(out.workflows_failed || 0), 1, 'missing policy root lease should block live external execution');

  let runPayload = JSON.parse(fs.readFileSync(path.join(runsDir, `${dateStr}.json`), 'utf8'));
  let blockedStep = runPayload.results && runPayload.results[0] && runPayload.results[0].step_results
    ? runPayload.results[0].step_results[0]
    : null;
  assert.ok(blockedStep && String(blockedStep.failure_reason || '') === 'policy_root_denied', 'failure should surface policy_root_denied');

  writeJson(subsumptionPolicyPath, {
    version: '1.0',
    min_trust_allow: 0.9,
    min_trust_escalate: 0.45,
    global_daily_tokens: 10000,
    providers: {
      mock_provider: {
        enabled: true,
        adapter: 'mock_ext',
        trust_score: 0.2,
        min_trust: 0.9,
        daily_tokens: 5000
      }
    }
  });

  const leaseForDeny = issueLease(root, baseEnv, 'workflow_external_orchestration', 'mock_provider');
  r = runExecutor(['--dry-run=0', `--lease-token=${leaseForDeny}`, '--approval-note=allow external ring step for deny test']);
  assert.strictEqual(r.status, 0, `subsumption deny run should return payload: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'subsumption deny payload should be ok envelope');
  assert.strictEqual(Number(out.workflows_failed || 0), 1, 'subsumption deny should fail workflow execution');
  runPayload = JSON.parse(fs.readFileSync(path.join(runsDir, `${dateStr}.json`), 'utf8'));
  blockedStep = runPayload.results && runPayload.results[0] && runPayload.results[0].step_results
    ? runPayload.results[0].step_results[0]
    : null;
  assert.ok(
    blockedStep && ['subsumption_denied', 'subsumption_escalated'].includes(String(blockedStep.failure_reason || '')),
    'failure should surface subsumption decision block'
  );

  writeJson(subsumptionPolicyPath, {
    version: '1.0',
    min_trust_allow: 0.7,
    min_trust_escalate: 0.45,
    global_daily_tokens: 10000,
    providers: {
      mock_provider: {
        enabled: true,
        adapter: 'mock_ext',
        trust_score: 0.95,
        min_trust: 0.7,
        daily_tokens: 5000
      }
    }
  });
  fs.rmSync(subsumptionStatePath, { force: true });

  const leaseForSuccess = issueLease(root, baseEnv, 'workflow_external_orchestration', 'mock_provider');
  r = runExecutor(['--dry-run=0', `--lease-token=${leaseForSuccess}`, '--approval-note=allow external ring step for success test']);
  assert.strictEqual(r.status, 0, `live external run with lease should pass: ${r.stderr}`);
  out = parsePayload(r.stdout);
  assert.ok(out && out.ok === true, 'success payload should be ok');
  assert.strictEqual(
    Number(out.workflows_succeeded || 0),
    1,
    `live external run with lease + subsumption allow should succeed: ${JSON.stringify(out)}`
  );
  assert.ok(fs.existsSync(expectedActuationReceiptPath), 'actuation receipt should be written for successful live run');
  fs.rmSync(localAdapterRoot, { recursive: true, force: true });

  console.log('workflow_executor_external_ring.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`workflow_executor_external_ring.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

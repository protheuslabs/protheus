#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(p, body + (body ? '\n' : ''), 'utf8');
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-safety-kernel-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const runsDir = path.join(tmp, 'state', 'autonomy', 'runs');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'mutation_safety_kernel');

  writeJson(policyPath, {
    version: '1.0',
    max_mutation_attempts_per_day: 2,
    high_risk_score_min: 70,
    medium_risk_score_min: 45,
    require_lineage_id: true,
    require_policy_root_for_high: true,
    require_dual_control_for_high: true
  });

  const day = new Date().toISOString().slice(0, 10);
  writeJsonl(path.join(runsDir, `${day}.jsonl`), [
    { ts: `${day}T00:00:00.000Z`, type: 'autonomy_run', proposal_type: 'adaptive_topology_mutation' },
    { ts: `${day}T01:00:00.000Z`, type: 'autonomy_run', proposal_type: 'adaptive_topology_mutation' }
  ]);

  const oldPolicyPath = process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH;
  const oldRunsDir = process.env.MUTATION_SAFETY_RUNS_DIR;
  const oldStateDir = process.env.MUTATION_SAFETY_STATE_DIR;

  process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH = policyPath;
  process.env.MUTATION_SAFETY_RUNS_DIR = runsDir;
  process.env.MUTATION_SAFETY_STATE_DIR = stateDir;

  try {
    const kernel = require(path.join(ROOT, 'systems', 'autonomy', 'mutation_safety_kernel.js'));
    const policy = kernel.loadPolicy(policyPath);

    const blocked = kernel.evaluateMutationSafetyEnvelope({
      policy,
      proposal: {
        type: 'adaptive_topology_mutation',
        title: 'High risk mutation touching security policy',
        summary: 'Execute topology mutation and governance rewiring',
        risk: 'high',
        meta: {}
      }
    });

    assert.strictEqual(blocked.applies, true, 'mutation proposal should apply expanded guard');
    assert.strictEqual(blocked.pass, false, 'missing controls should fail expanded guard');
    assert.ok(blocked.reasons.includes('mutation_rate_daily_cap_exceeded'), 'daily rate cap should trigger');
    assert.ok(blocked.reasons.includes('mutation_lineage_missing'), 'lineage should be required');
    assert.ok(blocked.reasons.includes('mutation_high_risk_policy_root_required'), 'high risk should require policy root approval');

    const passing = kernel.evaluateMutationSafetyEnvelope({
      policy,
      proposal: {
        type: 'adaptive_topology_mutation',
        title: 'Mutation with full high risk controls',
        summary: 'simulate canary topology mutation',
        risk: 'high',
        meta: {
          mutation_lineage_id: 'lineage_001',
          policy_root_approval_id: 'pr_001',
          dual_approval_id: 'da_001'
        }
      }
    });

    assert.strictEqual(passing.applies, true);
    assert.strictEqual(passing.pass, false, 'rate cap still blocks due saturated daily attempts');
    assert.ok(!passing.reasons.includes('mutation_lineage_missing'), 'lineage should be satisfied');

    console.log('mutation_safety_kernel.test.js: OK');
  } finally {
    if (oldPolicyPath == null) delete process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH;
    else process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH = oldPolicyPath;
    if (oldRunsDir == null) delete process.env.MUTATION_SAFETY_RUNS_DIR;
    else process.env.MUTATION_SAFETY_RUNS_DIR = oldRunsDir;
    if (oldStateDir == null) delete process.env.MUTATION_SAFETY_STATE_DIR;
    else process.env.MUTATION_SAFETY_STATE_DIR = oldStateDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`mutation_safety_kernel.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

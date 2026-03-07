#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'post_launch_migration_readiness.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-readiness-'));
  const policyPath = path.join(tmp, 'config', 'post_launch_migration_readiness_policy.json');

  const paths = {
    latest_path: path.join(tmp, 'state', 'ops', 'post_launch_migration_readiness', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'ops', 'post_launch_migration_readiness', 'receipts.jsonl'),
    final_review_path: path.join(tmp, 'state', 'ops', 'post_launch_migration_readiness', 'final_review.json'),
    execution_reliability_path: path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json'),
    ci_guard_path: path.join(tmp, 'state', 'ops', 'ci_baseline_guard.json'),
    workflow_closure_path: path.join(tmp, 'state', 'ops', 'workflow_execution_closure.json'),
    js_holdout_path: path.join(tmp, 'state', 'ops', 'js_holdout_audit', 'latest.json'),
    adapter_defrag_path: path.join(tmp, 'state', 'actuation', 'adapter_defragmentation', 'latest.json'),
    state_kernel_cutover_path: path.join(tmp, 'state', 'ops', 'state_kernel_cutover', 'latest.json'),
    parity_harness_path: path.join(tmp, 'state', 'ops', 'narrow_agent_parity_harness.json'),
    profile_compatibility_path: path.join(tmp, 'state', 'ops', 'profile_compatibility_gate', 'latest.json'),
    deployment_packaging_path: path.join(tmp, 'state', 'ops', 'deployment_packaging', 'latest.json'),
    self_hosted_bootstrap_path: path.join(tmp, 'state', 'ops', 'self_hosted_bootstrap', 'latest.json'),
    secret_rotation_attestation_path: path.join(tmp, 'config', 'secret_rotation_attestation.json'),
    remote_heartbeat_path: path.join(tmp, 'state', 'security', 'remote_tamper_heartbeat', 'latest.json'),
    supply_chain_path: path.join(tmp, 'state', 'security', 'supply_chain', 'latest.json'),
    docs_playbook_path: path.join(tmp, 'docs', 'POST_LAUNCH_MIGRATION_READINESS.md'),
    rollback_template_path: path.join(tmp, 'docs', 'release', 'templates', 'rollback_plan.md')
  };

  writeJson(paths.execution_reliability_path, { pass: true, window_days: 30, open_p0_incidents: 0 });
  writeJson(paths.ci_guard_path, { pass: true, streak: 7 });
  writeJson(paths.workflow_closure_path, { consecutive_days_passed: 7 });
  writeJson(paths.js_holdout_path, { strict_violations: [] });
  writeJson(paths.adapter_defrag_path, { profile_ratio: 0.95 });
  writeJson(paths.state_kernel_cutover_path, {
    evaluation: {
      validation: {
        parity_ok: true,
        replay_deterministic: true
      },
      shadow_days_elapsed: 10
    }
  });
  writeJson(paths.parity_harness_path, { parity_pass: true, updated_at: new Date().toISOString() });
  writeJson(paths.profile_compatibility_path, { failures: [] });
  writeJson(paths.deployment_packaging_path, { verdict: 'pass' });
  writeJson(paths.self_hosted_bootstrap_path, { ok: true, build_id: 'b_001' });
  writeJson(paths.secret_rotation_attestation_path, {
    flags: {
      active_keys_rotated: true,
      history_scrub_verified: true,
      secret_manager_migrated: true
    }
  });
  writeJson(paths.remote_heartbeat_path, { anomaly: false });
  writeJson(paths.supply_chain_path, { ok: true });
  writeText(paths.docs_playbook_path, '# playbook\n');
  writeText(paths.rollback_template_path, '# rollback\n');

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    strict_default: false,
    thresholds: {
      stability_days_required: 30,
      primitive_coverage_ratio: 0.9,
      parity_days_required: 14,
      min_workflow_closure_days: 7,
      min_ci_streak_days: 7
    },
    paths
  });

  let res = run(['run', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'post_launch_migration_readiness_run');
  assert.strictEqual(res.payload.checks.plm_010_final_review_present, false, 'final review should be missing before sign-off');

  res = run([
    'final-review',
    `--policy=${policyPath}`,
    '--decision=go',
    '--signed-by=jay',
    '--approval-note=plm_review_signed'
  ]);
  assert.strictEqual(res.status, 0, `final-review should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'post_launch_migration_final_review');
  assert.strictEqual(res.payload.decision, 'go');

  res = run(['run', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `strict run should pass after final review: ${res.stderr}`);
  assert.strictEqual(res.payload.ok, true);
  assert.strictEqual(res.payload.ready, true);

  res = run(['status', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `strict status should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.ok, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('post_launch_migration_readiness.test.js: OK');
} catch (err) {
  console.error(`post_launch_migration_readiness.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

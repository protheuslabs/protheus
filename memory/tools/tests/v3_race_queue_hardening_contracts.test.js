#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(cmd, args, env = process.env) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
}

(function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-race-queue-hardening-'));
  const ciQualityPolicyPath = path.join(tmpDir, 'ci_quality_scorecard_policy.json');
  fs.writeFileSync(ciQualityPolicyPath, `${JSON.stringify({
    version: '1.0-test',
    enabled: true,
    thresholds: {
      min_coverage_pct: 0,
      max_flake_rate: 1,
      max_p95_runtime_ms: 3_000_000,
      require_critical_suite_pass: true
    },
    history_window: 50
  }, null, 2)}\n`, 'utf8');

  const r = run('npm', ['run', '-s', 'ops:race-queue:hardening'], {
    ...process.env,
    SENSORY_QUEUE_THROTTLE_BYPASS: '1',
    CI_QUALITY_SCORECARD_POLICY_PATH: ciQualityPolicyPath
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
  }
  assert.strictEqual(r.status, 0, 'ops:race-queue:hardening should pass');

  const requiredArtifacts = [
    'state/ops/command_registry/latest.json',
    'state/ops/entrypoint_runtime_contract/latest.json',
    'state/ops/dependency_boundary_guard/latest.json',
    'state/ops/state_tiering_contract/latest.json',
    'state/ops/relocatable_path_contract/latest.json',
    'state/ops/package_manifest_contract/latest.json',
    'state/ops/docs_surface_contract/latest.json',
    'state/ops/root_surface_contract/latest.json',
    'state/ops/legal_language_contract/latest.json',
    'state/ops/ci_workflow_rationalization/latest.json',
    'state/ops/ci_quality_scorecard/latest.json'
  ];

  for (const relPath of requiredArtifacts) {
    const abs = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(abs), `expected artifact: ${relPath}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('v3_race_queue_hardening_contracts.test: ok');
})();

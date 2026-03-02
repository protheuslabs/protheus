#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

(function main() {
  const r = run('npm', ['run', '-s', 'ops:race-queue:hardening']);
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

  console.log('v3_race_queue_hardening_contracts.test: ok');
})();

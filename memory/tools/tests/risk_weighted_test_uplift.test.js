#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const LANE_RULES = [
  {
    lane: 'admission',
    minFiles: 2,
    files: [
      'memory/tools/tests/proposal_queue.test.js',
      'memory/tools/tests/directive_gate.test.js',
      'memory/tools/tests/autonomy_policy_hold_classification.test.js'
    ],
    denySignals: [/decision,\s*'deny'/, /decision,\s*'manual'/, /decision,\s*'reject'/, /policy_hold/, /blocked/],
    allowSignals: [/decision,\s*'allow'/, /decision,\s*'accept'/, /pass,\s*true/, /ok,\s*true/],
    mustInclude: [/policy_hold/, /decision,\s*'allow'/]
  },
  {
    lane: 'mutation_safety',
    minFiles: 2,
    files: [
      'memory/tools/tests/mutation_safety_kernel.test.js',
      'memory/tools/tests/quorum_validator.test.js',
      'memory/tools/tests/improvement_controller_two_phase.test.js'
    ],
    denySignals: [/pass,\s*false/, /ok,\s*false/, /denied/, /blocked/, /validator_disagreement/],
    allowSignals: [/pass,\s*true/, /ok,\s*true/, /lease_verified/],
    mustInclude: [/mutation_high_risk_policy_root_required/, /requires_quorum/]
  },
  {
    lane: 'rollback',
    minFiles: 2,
    files: [
      'memory/tools/tests/autonomy_actionability_rollback_guard.test.js',
      'memory/tools/tests/improvement_controller_two_phase.test.js',
      'memory/tools/tests/workflow_executor.test.js'
    ],
    denySignals: [/pass,\s*false/, /workflows_failed/, /workflows_blocked/, /verify_step_failed/, /fail/],
    allowSignals: [/pass,\s*true/, /workflows_succeeded/, /runtime_mutations_applied/, /ok,\s*true/],
    mustInclude: [/rollback_signal/, /medium_risk_missing_rollback_path/]
  },
  {
    lane: 'emergency_stop',
    minFiles: 2,
    files: [
      'memory/tools/tests/emergency_stop.test.js',
      'memory/tools/tests/emergency_stop_cli.test.js',
      'memory/tools/tests/route_task_emergency_stop.test.js'
    ],
    denySignals: [/gate_decision,\s*'deny'/, /notstrictequal\(r\.status,\s*0/, /engaged,\s*true/, /reason.*emergency stop/],
    allowSignals: [/result,\s*'released'/, /engaged,\s*false/, /ok,\s*true/],
    mustInclude: [/result,\s*'engaged'/, /result,\s*'released'/]
  },
  {
    lane: 'policy_root',
    minFiles: 2,
    files: [
      'memory/tools/tests/policy_rootd_lease.test.js',
      'memory/tools/tests/strategy_mode_governor_policy_root.test.js',
      'memory/tools/tests/improvement_controller_policy_root.test.js'
    ],
    denySignals: [/lease_token_required/, /policy_root_denied/, /ok,\s*false/, /blocked_policy_root/, /notstrictequal\(r\.status,\s*0/],
    allowSignals: [/lease_verified/, /mode_changed/, /ok,\s*true/, /decision,\s*'allow'/],
    mustInclude: [/lease_token_required/, /lease_verified/]
  }
];

function readLower(relPath) {
  const absPath = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, 'utf8').toLowerCase();
}

function extractAssertions(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('assert.'));
}

function run() {
  const laneSummary = [];
  for (const rule of LANE_RULES) {
    const contents = rule.files
      .map((f) => ({ file: f, body: readLower(f), asserts: [] }))
      .map((row) => ({
        ...row,
        asserts: row.body == null ? [] : extractAssertions(row.body)
      }))
      .filter((row) => row.body != null);

    assert.ok(
      contents.length >= rule.minFiles,
      `${rule.lane}: expected at least ${rule.minFiles} test files, found ${contents.length}`
    );

    const assertRows = contents.flatMap((row) =>
      row.asserts.map((assertLine) => ({ file: row.file, line: assertLine }))
    );

    const denyHits = assertRows.filter((row) => rule.denySignals.some((re) => re.test(row.line)));
    const allowHits = assertRows.filter((row) => rule.allowSignals.some((re) => re.test(row.line)));
    const denyFiles = new Set(denyHits.map((row) => row.file));
    const allowFiles = new Set(allowHits.map((row) => row.file));

    assert.ok(denyHits.length > 0, `${rule.lane}: missing deny-path assertion evidence`);
    assert.ok(allowHits.length > 0, `${rule.lane}: missing allow-path assertion evidence`);
    assert.ok(denyFiles.size > 0 && allowFiles.size > 0, `${rule.lane}: allow/deny branch evidence must map to test files`);

    for (const required of rule.mustInclude || []) {
      const present = contents.some((row) => required.test(row.body));
      assert.ok(present, `${rule.lane}: missing required lane signal ${required}`);
    }

    laneSummary.push({
      lane: rule.lane,
      files: contents.length,
      deny_assertions: denyHits.length,
      allow_assertions: allowHits.length,
      deny_files: denyFiles.size,
      allow_files: allowFiles.size
    });
  }

  console.log(JSON.stringify({ ok: true, lanes: laneSummary }, null, 2));
  console.log('risk_weighted_test_uplift.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`risk_weighted_test_uplift.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

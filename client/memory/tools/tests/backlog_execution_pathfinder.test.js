#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_execution_pathfinder.js');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-pathfinder-'));
  ensureDir(path.join(ws, 'config'));
  ensureDir(path.join(ws, 'docs', 'backlog_views'));
  ensureDir(path.join(ws, 'state', 'ops'));

  writeJson(path.join(ws, 'config', 'backlog_registry.json'), {
    schema_id: 'backlog_registry_v1',
    schema_version: '1.0',
    generated_at: '2026-03-03T00:00:00.000Z',
    row_count: 5,
    rows: [
      {
        id: 'V3-RACE-001',
        class: 'primitive-upgrade',
        wave: 'V3',
        status: 'done',
        title: 'Kernel',
        problem: 'p',
        acceptance: 'a',
        dependencies: []
      },
      {
        id: 'V3-RACE-002',
        class: 'extension',
        wave: 'V3',
        status: 'queued',
        title: 'Runnable and ready',
        problem: 'p',
        acceptance: 'a',
        dependencies: [
          'V3-RACE-001'
        ]
      },
      {
        id: 'V3-RACE-003',
        class: 'extension',
        wave: 'V3',
        status: 'queued',
        title: 'Runnable but blocked',
        problem: 'p',
        acceptance: 'a',
        dependencies: [
          'V3-RACE-004'
        ]
      },
      {
        id: 'V3-RACE-004',
        class: 'hardening',
        wave: 'V3',
        status: 'queued',
        title: 'No lane and blocked',
        problem: 'p',
        acceptance: 'a',
        dependencies: [
          'V3-RACE-999'
        ]
      },
      {
        id: 'V3-RACE-005',
        class: 'hardening',
        wave: 'V3',
        status: 'queued',
        title: 'No lane but ready',
        problem: 'p',
        acceptance: 'a',
        dependencies: []
      }
    ]
  });

  writeJson(path.join(ws, 'package.json'), {
    scripts: {
      'lane:v3-race-002:run': 'node client/systems/v3_race_002.js run',
      'lane:v3-race-003:run': 'node client/systems/v3_race_003.js run'
    }
  });

  writeJson(path.join(ws, 'config', 'backlog_execution_pathfinder_policy.json'), {
    version: '1.0',
    enabled: true,
    source_registry_path: path.join(ws, 'config', 'backlog_registry.json'),
    package_json_path: path.join(ws, 'package.json'),
    outputs: {
      latest_path: path.join(ws, 'state', 'ops', 'backlog_execution_pathfinder', 'latest.json'),
      history_path: path.join(ws, 'state', 'ops', 'backlog_execution_pathfinder', 'history.jsonl'),
      report_path: path.join(ws, 'state', 'ops', 'backlog_execution_pathfinder', 'report.json'),
      report_md_path: path.join(ws, 'docs', 'backlog_views', 'execution_path.md')
    }
  });

  return ws;
}

function runCmd(ws, args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKLOG_EXECUTION_PATHFINDER_POLICY_PATH: path.join(ws, 'config', 'backlog_execution_pathfinder_policy.json')
    }
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   BACKLOG EXECUTION PATHFINDER TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('run classifies queue into executable vs spec-only buckets', () => {
  const ws = makeWorkspace();
  const r = runCmd(ws, ['run']);
  assert.strictEqual(r.status, 0, `run failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(Number(out.queued_total || 0), 4, 'queued_total mismatch');
  assert.strictEqual(Number(out.buckets.runnable_ready_count || 0), 1, 'runnable_ready_count mismatch');
  assert.strictEqual(Number(out.buckets.runnable_blocked_count || 0), 1, 'runnable_blocked_count mismatch');
  assert.strictEqual(Number(out.buckets.spec_ready_count || 0), 1, 'spec_ready_count mismatch');
  assert.strictEqual(Number(out.buckets.spec_blocked_count || 0), 1, 'spec_blocked_count mismatch');

  const reportPath = path.join(ws, 'state', 'ops', 'backlog_execution_pathfinder', 'report.json');
  const mdPath = path.join(ws, 'docs', 'backlog_views', 'execution_path.md');
  assert.ok(fs.existsSync(reportPath), 'report.json missing');
  assert.ok(fs.existsSync(mdPath), 'execution_path.md missing');

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.ok(Array.isArray(report.top_dependency_blockers), 'missing blockers array');
  assert.ok(report.top_dependency_blockers.some((row) => row.dependency === 'V3-RACE-004'), 'expected blocker V3-RACE-004');
});

runTest('status returns latest summary after run', () => {
  const ws = makeWorkspace();
  const run = runCmd(ws, ['run']);
  assert.strictEqual(run.status, 0, `run failed: ${run.stderr}`);

  const status = runCmd(ws, ['status']);
  assert.strictEqual(status.status, 0, `status failed: ${status.stderr}`);
  const out = parseJson(status.stdout);
  assert.ok(out && out.ok === true, 'status expected ok=true');
  assert.ok(out.report_summary, 'missing report_summary');
  assert.strictEqual(Number(out.report_summary.runnable_ready_count || 0), 1, 'status runnable count mismatch');
});

if (failed) {
  process.exit(1);
}

console.log('✅ backlog_execution_pathfinder tests passed');

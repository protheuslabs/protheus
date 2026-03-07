#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'critical_path_policy_coverage.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-path-coverage-'));
  const commandPath = path.join(tmp, 'systems', 'ops', 'sample_lane.ts');
  const commandJsPath = path.join(tmp, 'systems', 'ops', 'sample_lane.js');
  const policyArtifact = path.join(tmp, 'config', 'sample_lane_policy.json');
  const testPath = path.join(tmp, 'memory', 'tools', 'tests', 'sample_lane.test.js');
  const guardRegistryPath = path.join(tmp, 'config', 'guard_check_registry.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'critical_path_policy_coverage', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'critical_path_policy_coverage', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'critical_path_policy_coverage_policy.json');

  write(commandPath, '#!/usr/bin/env node\n');
  write(commandJsPath, '#!/usr/bin/env node\n');
  writeJson(policyArtifact, { ok: true });
  write(testPath, '#!/usr/bin/env node\n');
  writeJson(guardRegistryPath, {
    schema_id: 'guard_check_registry',
    schema_version: '1.0.0',
    merge_guard: {
      checks: [
        {
          id: 'sample_lane_status',
          command: 'node',
          args: ['client/systems/ops/sample_lane.js']
        }
      ],
      optional_checks: []
    },
    contract_check: {
      required_merge_guard_ids: []
    }
  });

  writeJson(policyPath, {
    schema_id: 'critical_path_policy_coverage_policy',
    schema_version: '1.0-test',
    enabled: true,
    strict_default: false,
    require_merge_guard_hooks: true,
    critical_paths: [
      {
        id: 'sample_lane',
        command_path: commandPath,
        policy_paths: [policyArtifact],
        test_paths: [testPath]
      }
    ],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    CRITICAL_PATH_COVERAGE_ROOT: tmp,
    CRITICAL_PATH_COVERAGE_POLICY_PATH: policyPath,
    GUARD_CHECK_REGISTRY_PATH: guardRegistryPath
  };

  let out = run(['run', '--strict=1'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'coverage run should pass strict');
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'coverage payload should be ok');
  assert.strictEqual(payload.coverage.uncovered_paths, 0, 'all paths should be covered');
  assert.ok(payload.coverage.merge_guard_registry, 'registry metadata should be present');
  assert.strictEqual(payload.coverage.merge_guard_registry.available, true, 'registry should be loaded');
  assert.ok(fs.existsSync(latestPath), 'latest output should exist');
  assert.ok(fs.existsSync(historyPath), 'history output should exist');

  writeJson(guardRegistryPath, {
    schema_id: 'guard_check_registry',
    schema_version: '1.0.0',
    merge_guard: {
      checks: [],
      optional_checks: []
    },
    contract_check: {
      required_merge_guard_ids: []
    }
  });
  out = run(['run', '--strict=0'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'non-strict run should complete');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === false, 'coverage should fail when hook missing');
  assert.ok(
    Array.isArray(payload.coverage.rows) &&
      payload.coverage.rows[0] &&
      Array.isArray(payload.coverage.rows[0].uncovered_reasons) &&
      payload.coverage.rows[0].uncovered_reasons.some((r) => String(r).includes('merge_guard_hook_missing')),
    'missing merge guard hook reason should be present'
  );

  out = run(['status'], env);
  assert.strictEqual(out.status, 0, out.stderr || 'status should execute');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.ok(payload.payload && payload.payload.type === 'critical_path_policy_coverage', 'status should expose latest coverage');

  console.log('critical_path_policy_coverage.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`critical_path_policy_coverage.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

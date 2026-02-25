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

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function parseStdoutJson(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, 'expected stdout json payload');
  return JSON.parse(raw);
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'ops', 'organ_atrophy_controller.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'organ-atrophy-'));
  const dateStr = '2026-02-25';

  const systemsRoot = path.join(tmp, 'systems');
  const spineRunsDir = path.join(tmp, 'state', 'spine', 'runs');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'organs', 'atrophy');
  const dormantDir = path.join(tmp, 'state', 'autonomy', 'organs', 'dormant');
  const autotestRegistryPath = path.join(tmp, 'state', 'ops', 'autotest', 'registry.json');
  const policyPath = path.join(tmp, 'config', 'organ_atrophy_policy.json');

  writeFile(path.join(systemsRoot, 'spine', 'spine.ts'), 'export const ok = true;\n');
  writeFile(path.join(systemsRoot, 'security', 'guard.ts'), 'export const ok = true;\n');
  writeFile(path.join(systemsRoot, 'workflow', 'workflow_controller.ts'), 'export const ok = true;\n');
  writeFile(path.join(systemsRoot, 'fractal', 'regime_organ.ts'), 'export const ok = true;\n');
  writeFile(path.join(systemsRoot, 'continuum', 'continuum_core.ts'), 'export const ok = true;\n');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_mode: true,
    window_days: 30,
    max_candidates: 5,
    min_observations: 1,
    usefulness_threshold: 0.5,
    min_inactive_days: 1,
    max_touch_count_for_candidate: 1,
    scoring: {
      activity_weight: 0.55,
      health_weight: 0.3,
      test_weight: 0.15,
      touch_norm: 10
    },
    exclusions: {
      organ_ids: ['spine', 'security', 'identity', 'contracts'],
      path_prefixes: ['systems/spine/', 'systems/security/', 'systems/identity/', 'systems/contracts/']
    },
    endpoint: {
      enabled: true,
      max_files_sample: 30,
      max_manifest_chars: 40000
    },
    revive: {
      enabled: true,
      allow_manual: true,
      require_existing_endpoint: true,
      shadow_only: true
    }
  });

  writeJsonl(path.join(spineRunsDir, `${dateStr}.jsonl`), [
    {
      ts: '2026-02-25T12:00:00.000Z',
      type: 'spine_run_started',
      files_touched: [
        'systems/workflow/workflow_controller.ts',
        'systems/fractal/regime_organ.ts'
      ]
    },
    {
      ts: '2026-02-25T12:00:05.000Z',
      type: 'spine_fractal_regime_organ',
      ok: true
    },
    {
      ts: '2026-02-25T12:00:06.000Z',
      type: 'spine_workflow_controller',
      ok: true
    }
  ]);

  writeJson(autotestRegistryPath, {
    modules: {
      'systems/workflow/workflow_controller.ts': { checked: true },
      'systems/fractal/regime_organ.ts': { checked: true },
      'systems/continuum/continuum_core.ts': { checked: false, stale: true }
    }
  });

  const env = {
    ...process.env,
    ORGAN_ATROPHY_POLICY_PATH: policyPath,
    ORGAN_ATROPHY_STATE_DIR: stateDir,
    ORGAN_ATROPHY_DORMANT_DIR: dormantDir,
    ORGAN_ATROPHY_SYSTEMS_ROOT: systemsRoot,
    ORGAN_ATROPHY_SPINE_RUNS_DIR: spineRunsDir,
    ORGAN_ATROPHY_AUTOTEST_REGISTRY_PATH: autotestRegistryPath
  };

  const scanProc = runNode(scriptPath, [
    'scan',
    dateStr,
    '--window-days=30',
    '--max-candidates=5',
    '--persist=1',
    '--write-endpoints=1'
  ], env, repoRoot);
  assert.strictEqual(scanProc.status, 0, scanProc.stderr || 'scan should pass');
  const scanOut = parseStdoutJson(scanProc);
  assert.strictEqual(scanOut.ok, true);
  assert.ok(Number(scanOut.scanned_organs || 0) >= 3, 'should scan non-excluded organs');
  assert.ok(Number(scanOut.candidates_count || 0) >= 1, 'should produce atrophy candidates');
  assert.ok(Array.isArray(scanOut.candidates), 'candidates list required');
  const continuumCandidate = scanOut.candidates.find((row) => String(row.organ_id) === 'continuum');
  assert.ok(continuumCandidate, 'continuum should be a candidate in this fixture');

  const endpointPath = path.join(dormantDir, 'continuum.json');
  assert.ok(fs.existsSync(endpointPath), 'dormant endpoint should be materialized');
  const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
  assert.strictEqual(endpoint.schema_id, 'organ_dormant_endpoint');
  assert.strictEqual(endpoint.organ_id, 'continuum');

  const statusProc = runNode(scriptPath, ['status', 'latest'], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || 'status should pass');
  const statusOut = parseStdoutJson(statusProc);
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.candidates_count || 0) >= 1);

  const reviveProc = runNode(scriptPath, [
    'revive',
    '--organ-id=continuum',
    '--reason=test_manual_revive',
    '--persist=1'
  ], env, repoRoot);
  assert.strictEqual(reviveProc.status, 0, reviveProc.stderr || 'revive should pass');
  const reviveOut = parseStdoutJson(reviveProc);
  assert.strictEqual(reviveOut.ok, true);
  assert.strictEqual(reviveOut.organ_id, 'continuum');
  assert.strictEqual(reviveOut.endpoint_found, true);
  assert.strictEqual(reviveOut.shadow_only, true);
  assert.ok(fs.existsSync(path.join(stateDir, 'revive_queue.jsonl')), 'revive queue should be created');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('organ_atrophy_controller.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`organ_atrophy_controller.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJson(proc, label) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `${label}: expected json stdout`);
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'memory', 'memory_federation_plane.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-federation-'));

  const policyPath = path.join(tmp, 'config', 'memory_federation_policy.json');
  const stateDir = path.join(tmp, 'state', 'memory', 'federation');
  const sourceWeaver = path.join(tmp, 'state', 'autonomy', 'weaver', 'history.jsonl');
  const sourceMirror = path.join(tmp, 'state', 'autonomy', 'mirror_organ', 'history.jsonl');
  const sourceLearning = path.join(tmp, 'state', 'workflow', 'learning_conduit', 'receipts.jsonl');

  const oldTs = new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString();
  writeJsonl(sourceWeaver, [
    {
      ts: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
      objective_id: 'obj_a',
      primary_metric_id: 'learning',
      value_currency: 'learning',
      top_share: 0.41,
      reason_codes: ['quality_shift']
    },
    {
      ts: oldTs,
      objective_id: 'obj_old',
      primary_metric_id: 'revenue',
      value_currency: 'revenue',
      top_share: 0.91,
      reason_codes: ['legacy_signal']
    }
  ]);
  writeJsonl(sourceMirror, [
    {
      ts: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
      objective_id: 'obj_a',
      metric_id: 'learning',
      value_currency: 'learning',
      share: 0.39,
      reason_codes: ['mirror_feedback']
    }
  ]);
  writeJsonl(sourceLearning, [
    {
      ts: new Date(Date.now() - (30 * 60 * 1000)).toISOString(),
      objective_id: 'obj_b',
      metric_id: 'quality',
      value_currency: 'quality',
      share: 0.32,
      reason_codes: ['learning_receipt']
    }
  ]);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    compaction: {
      source_paths: [sourceWeaver, sourceMirror, sourceLearning],
      max_source_rows_per_path: 1000
    },
    stale_pruning: {
      enabled: true,
      max_age_days: 90,
      min_hits_keep: 2
    },
    federation: {
      enabled: true,
      opt_in_required: true,
      attestation_required: true,
      local_instance_id: 'local_test'
    }
  });

  const env = {
    ...process.env,
    MEMORY_FEDERATION_POLICY_PATH: policyPath,
    MEMORY_FEDERATION_STATE_DIR: stateDir
  };

  const distill = runNode(scriptPath, ['distill', '--apply=1'], env, repoRoot);
  assert.strictEqual(distill.status, 0, distill.stderr || distill.stdout);
  const distillOut = parseJson(distill, 'distill');
  assert.strictEqual(distillOut.ok, true);
  assert.strictEqual(distillOut.deterministic_replay, true);
  assert.ok(Number(distillOut.kept_count || 0) >= 2);
  assert.ok(Number(distillOut.pruned_count || 0) >= 1, 'old low-hit archetype should be pruned');
  assert.ok(fs.existsSync(path.join(stateDir, 'distilled_latest.json')));

  const exportNoOptIn = runNode(scriptPath, ['export', '--instance-id=local_test'], env, repoRoot);
  assert.notStrictEqual(exportNoOptIn.status, 0, 'export should require opt-in');

  const exportYes = runNode(scriptPath, [
    'export',
    '--instance-id=local_test',
    '--opt-in=1'
  ], env, repoRoot);
  assert.strictEqual(exportYes.status, 0, exportYes.stderr || exportYes.stdout);
  const exportOut = parseJson(exportYes, 'export_yes');
  assert.strictEqual(exportOut.ok, true);
  assert.ok(Number(exportOut.archetypes_count || 0) >= 1);

  const exchangeDir = path.join(stateDir, 'exchange');
  const exports = fs.readdirSync(exchangeDir).filter((name) => name.endsWith('.json'));
  assert.ok(exports.length >= 1, 'export package should exist');
  const packagePath = path.join(exchangeDir, exports[0]);
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  const importBad = runNode(scriptPath, [
    'import',
    `--file=${packagePath}`,
    '--opt-in=1',
    '--attestation=wrong_attestation'
  ], env, repoRoot);
  assert.strictEqual(importBad.status, 0, importBad.stderr || importBad.stdout);
  const importBadOut = parseJson(importBad, 'import_bad');
  assert.strictEqual(importBadOut.fallback_local_only, true);

  const importGood = runNode(scriptPath, [
    'import',
    `--file=${packagePath}`,
    '--opt-in=1',
    `--attestation=${pkg.attestation}`
  ], env, repoRoot);
  assert.strictEqual(importGood.status, 0, importGood.stderr || importGood.stdout);
  const importGoodOut = parseJson(importGood, 'import_good');
  assert.strictEqual(importGoodOut.ok, true);
  assert.strictEqual(importGoodOut.fallback_local_only, false);
  assert.ok(Number(importGoodOut.imported || 0) >= 1);

  const status = runNode(scriptPath, ['status'], env, repoRoot);
  assert.strictEqual(status.status, 0, status.stderr || status.stdout);
  const statusOut = parseJson(status, 'status');
  assert.strictEqual(statusOut.ok, true);
  assert.ok(Number(statusOut.counts.local_archetypes || 0) >= 1);
  assert.ok(Number(statusOut.counts.imported_archetypes || 0) >= 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('memory_federation_plane.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`memory_federation_plane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

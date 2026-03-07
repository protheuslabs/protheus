#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'actuation', 'adapter_defragmentation.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-defrag-'));
  const date = '2026-02-27';
  const adaptersPath = path.join(tmp, 'config', 'actuation_adapters.json');
  const universalRoot = path.join(tmp, 'state', 'actuation', 'universal_execution_primitive', 'receipts');
  const actuationRoot = path.join(tmp, 'state', 'actuation', 'receipts');
  const stateRoot = path.join(tmp, 'state', 'actuation', 'adapter_defragmentation');
  const policyPath = path.join(tmp, 'config', 'adapter_defragmentation_policy.json');

  writeJson(adaptersPath, {
    version: '1.0',
    adapters: {
      shared_http: {
        module: 'client/systems/actuation/multi_channel_adapter.js',
        description: 'shared http'
      },
      bespoke_legacy: {
        module: 'client/systems/actuation/legacy_one_off_adapter.js',
        description: 'legacy bespoke'
      }
    }
  });

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    adapters_path: adaptersPath,
    universal_receipts_root: universalRoot,
    actuation_receipts_root: actuationRoot,
    state_root: stateRoot,
    low_usage_threshold: 3,
    profile_ratio_target: 0.8,
    shared_module_hints: ['client/systems/actuation/multi_channel_adapter.js'],
    exempt_adapters: []
  });

  writeJsonl(path.join(universalRoot, `${date}.jsonl`), [
    { adapter_kind: 'shared_http', ok: true, profile_id: 'p1' },
    { adapter_kind: 'shared_http', ok: true, profile_id: 'p2' }
  ]);
  writeJsonl(path.join(actuationRoot, `${date}.jsonl`), [
    { adapter: 'shared_http', ok: true },
    { adapter: 'bespoke_legacy', ok: true }
  ]);

  const runOut = run(['run', date, `--policy=${policyPath}`]);
  assert.strictEqual(runOut.status, 0, runOut.stderr || runOut.stdout);
  const payload = parseJson(runOut.stdout);
  assert.strictEqual(payload.ok, true, 'run payload should be ok');
  assert.strictEqual(Number(payload.total_adapters || 0), 2, 'should inventory adapters');
  assert.ok(Number(payload.profile_ratio || 0) > 0, 'profile ratio should be non-zero');
  assert.ok(Array.isArray(payload.candidates), 'candidates should be array');
  assert.ok(
    payload.candidates.some((row) => row && row.adapter_id === 'bespoke_legacy'),
    'low-usage bespoke adapter should be candidate for consolidation'
  );

  const statusOut = run(['status', 'latest', `--policy=${policyPath}`]);
  assert.strictEqual(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const statusPayload = parseJson(statusOut.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status payload should be ok');
  assert.strictEqual(Number(statusPayload.total_adapters || 0), 2, 'status should surface latest snapshot');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('adapter_defragmentation.test.js: OK');
} catch (err) {
  console.error(`adapter_defragmentation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'openfang_capability_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return { status: res.status == null ? 1 : res.status, payload, stderr: String(res.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openfang-cap-pack-'));
  const policyPath = path.join(tmp, 'config', 'openfang_capability_pack_policy.json');
  const runtimePath = path.join(tmp, 'state', 'ops', 'runtime_efficiency_floor', 'latest.json');
  const adaptersPath = path.join(tmp, 'config', 'actuation_adapters.json');
  const manifestPath = path.join(tmp, 'pack_manifest.json');
  const importPath = path.join(tmp, 'import.json');

  writeJson(runtimePath, {
    payload: {
      metrics: {
        cold_start_p95_ms: 211,
        idle_rss_p95_mb: 38,
        install_artifact_total_mb: 3.5
      }
    }
  });

  writeJson(adaptersPath, {
    adapters: [
      { id: 'slack', risk: 'medium', rate_limit: 30, fallback: 'email' },
      { id: 'email', risk: 'medium', rate_limit: 20, fallback: 'local' }
    ]
  });

  writeJson(manifestPath, {
    objective: 'lead_gen',
    permissions: ['email.send'],
    risk: 'medium',
    budget: { usd: 20 },
    schedule: 'hourly',
    adapters: ['email'],
    rollback: { mode: 'disable_pack' }
  });

  writeJson(importPath, {
    objective: 'imported objective',
    steps: [{ id: 'a' }, { id: 'b' }]
  });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: path.join(tmp, 'state', 'ops', 'openfang_capability_pack', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'openfang_capability_pack', 'receipts.jsonl'),
      state_path: path.join(tmp, 'state', 'ops', 'openfang_capability_pack', 'state.json'),
      manifests_index_path: path.join(tmp, 'state', 'ops', 'openfang_capability_pack', 'manifests.json'),
      migration_output_path: path.join(tmp, 'state', 'ops', 'openfang_capability_pack', 'migrations.jsonl'),
      benchmark_path: path.join(tmp, 'state', 'ops', 'public_benchmark_pack', 'openfang_capability_pack.json'),
      runtime_efficiency_path: runtimePath,
      adapters_path: adaptersPath
    }
  });

  let res = run(['fuel-runtime', `--policy=${policyPath}`, '--fuel-budget=100', '--fuel-used=12']);
  assert.strictEqual(res.status, 0, `fuel-runtime should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.fuel_remaining, 88);

  res = run(['taint-evaluate', `--policy=${policyPath}`, '--labels=public,pii', '--sink=external_webhook']);
  assert.strictEqual(res.status, 0, `taint-evaluate should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.blocked, true);

  res = run(['ssrf-guard', `--policy=${policyPath}`, '--url=https://api.openai.com/v1/models']);
  assert.strictEqual(res.status, 0, `ssrf-guard should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.allow, true);

  res = run(['pack-manifest', `--policy=${policyPath}`, `--manifest=${manifestPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `pack-manifest should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.valid, true);

  res = run(['pack-signature', `--policy=${policyPath}`, `--manifest=${manifestPath}`]);
  assert.strictEqual(res.status, 0, `pack-signature should pass: ${res.stderr}`);
  assert.ok(res.payload.signature, 'signature expected');

  res = run(['framework-import', `--policy=${policyPath}`, `--input=${importPath}`, '--framework=langgraph', '--apply=1']);
  assert.strictEqual(res.status, 0, `framework-import should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.framework, 'langgraph');

  res = run(['channel-contracts', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `channel-contracts should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.channel_count, 2);

  res = run(['benchmark-pack', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `benchmark-pack should pass: ${res.stderr}`);
  assert.strictEqual(Number(res.payload.metrics.cold_start_p95_ms), 211);

  res = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.state, 'status state expected');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('openfang_capability_pack.test.js: OK');
} catch (err) {
  console.error(`openfang_capability_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

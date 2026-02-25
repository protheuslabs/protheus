#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'nursery', 'nursery_bootstrap.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nursery-bootstrap-'));
  const nurseryRoot = path.join(tmp, 'nursery');
  const policyPath = path.join(tmp, 'config', 'nursery_policy.json');

  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_missing_required_models: true,
    root_dir: nurseryRoot,
    directories: {
      seeds: 'seeds',
      manifests: 'manifests',
      containment: 'containment'
    },
    model_artifacts: [
      {
        id: 'tinyllama_stub',
        provider: 'local_stub',
        model: 'tinyllama:test',
        required: true,
        auto_pull: true
      }
    ]
  });

  let res = run(['run', `--policy=${policyPath}`, '--strict'], {
    NURSERY_AUTO_PULL: '1'
  });
  assert.strictEqual(res.status, 0, `nursery run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'expected nursery run ok=true');
  assert.strictEqual(Number(res.payload.artifacts_total || 0), 1, 'expected one artifact');
  assert.strictEqual(Number(res.payload.artifacts_ready || 0), 1, 'expected one ready artifact');

  const manifestPath = path.join(nurseryRoot, 'manifests', 'seed_manifest.json');
  const seedPath = path.join(nurseryRoot, 'seeds', 'tinyllama_stub.seed.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest should exist after run');
  assert.ok(fs.existsSync(seedPath), 'local stub seed should be created on run');

  res = run(['status', `--policy=${policyPath}`], {});
  assert.strictEqual(res.status, 0, `nursery status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'expected nursery status ok=true');
  assert.strictEqual(Boolean(res.payload.write), false, 'status mode should report write=false');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('nursery_bootstrap.test.js: OK');
} catch (err) {
  console.error(`nursery_bootstrap.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

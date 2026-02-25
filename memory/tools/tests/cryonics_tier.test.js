#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'memory', 'cryonics_tier.js');

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, String(text), 'utf8');
}

function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  let payload = null;
  try {
    payload = JSON.parse(String(r.stdout || '').trim());
  } catch {}
  return {
    status: r.status == null ? 0 : r.status,
    payload,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '')
  };
}

function setFileAgeDays(filePath, daysAgo) {
  const ts = Date.now() - (Number(daysAgo) * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, ts / 1000, ts / 1000);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cryonics-tier-'));
  const root = path.join(tmp, 'workspace');
  mkdirp(root);

  const oldSourceRel = 'state/sensory/eyes/raw/old-eye.json';
  const newSourceRel = 'state/sensory/eyes/raw/new-eye.json';
  const oldSourceAbs = path.join(root, oldSourceRel);
  const newSourceAbs = path.join(root, newSourceRel);

  writeText(oldSourceAbs, JSON.stringify({ source: 'old', value: 'alpha', ts: '2026-02-01T00:00:00Z' }, null, 2));
  writeText(newSourceAbs, JSON.stringify({ source: 'new', value: 'beta', ts: '2026-02-25T00:00:00Z' }, null, 2));

  setFileAgeDays(oldSourceAbs, 10);
  setFileAgeDays(newSourceAbs, 1);

  const policyPath = path.join(root, 'config', 'cryonics_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    default_profile: 'state_phase1',
    profiles: {
      state_phase1: {
        registry_path: 'state/memory/cryonics_registry.json',
        remove_source_after_verify: true,
        keep_versions_per_source: 3,
        max_files_per_run: 100,
        tiers: [
          {
            id: 'warm',
            source_prefixes: ['state/sensory/eyes/raw'],
            dest_prefix: 'state/_cryonics/warm',
            compression: 'gzip',
            min_age_days: 7
          }
        ]
      }
    }
  });

  let r = run([
    'run',
    `--root=${root}`,
    `--policy=${policyPath}`,
    '--profile=state_phase1'
  ]);
  assert.strictEqual(r.status, 0, `run should pass: ${r.stderr || r.stdout}`);
  assert.ok(r.payload && r.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(Number(r.payload.archived_count || 0), 1, 'exactly one old file should be archived');
  assert.strictEqual(Number(r.payload.source_deleted_count || 0), 1, 'old source file should be deleted after archive');

  assert.ok(!fs.existsSync(oldSourceAbs), 'old source should be removed');
  assert.ok(fs.existsSync(newSourceAbs), 'new source should remain hot');

  const archiveAbs = path.join(root, 'state/_cryonics/warm/state/sensory/eyes/raw/old-eye.json.gz');
  assert.ok(fs.existsSync(archiveAbs), 'archive file should exist');

  const registryPath = path.join(root, 'state/memory/cryonics_registry.json');
  assert.ok(fs.existsSync(registryPath), 'registry should exist');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const regEntry = registry.entries && registry.entries[oldSourceRel];
  assert.ok(regEntry && regEntry.latest, 'registry should have latest version for source file');
  assert.strictEqual(String(regEntry.latest.archived_rel), 'state/_cryonics/warm/state/sensory/eyes/raw/old-eye.json.gz');

  r = run([
    'verify',
    `--root=${root}`,
    `--policy=${policyPath}`,
    '--profile=state_phase1'
  ]);
  assert.strictEqual(r.status, 0, `verify should pass: ${r.stderr || r.stdout}`);
  assert.ok(r.payload && r.payload.ok === true, 'verify payload should be ok');
  assert.strictEqual(Number(r.payload.verified || 0), 1, 'one archived file should verify');

  r = run([
    'restore',
    `--root=${root}`,
    `--policy=${policyPath}`,
    '--profile=state_phase1',
    `--source=${oldSourceRel}`
  ]);
  assert.strictEqual(r.status, 0, `restore should pass: ${r.stderr || r.stdout}`);
  assert.ok(r.payload && r.payload.ok === true, 'restore payload should be ok');
  assert.strictEqual(Number(r.payload.restored || 0), 1, 'one file should be restored');
  assert.ok(fs.existsSync(oldSourceAbs), 'restored source should exist');

  const restoredObj = JSON.parse(fs.readFileSync(oldSourceAbs, 'utf8'));
  assert.strictEqual(restoredObj.value, 'alpha', 'restored content should match original');

  const dryRunSourceRel = 'state/sensory/eyes/raw/dry-run.json';
  const dryRunSourceAbs = path.join(root, dryRunSourceRel);
  writeText(dryRunSourceAbs, JSON.stringify({ source: 'dry', value: 'gamma' }));
  setFileAgeDays(dryRunSourceAbs, 12);

  r = run([
    'run',
    `--root=${root}`,
    `--policy=${policyPath}`,
    '--profile=state_phase1',
    '--dry-run'
  ]);
  assert.strictEqual(r.status, 0, `dry-run should pass: ${r.stderr || r.stdout}`);
  assert.ok(r.payload && r.payload.ok === true, 'dry-run payload should be ok');
  assert.ok(fs.existsSync(dryRunSourceAbs), 'dry-run must not delete source file');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('cryonics_tier.test.js: OK');
} catch (err) {
  console.error(`cryonics_tier.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

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

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(root, 'systems', 'ops', 'schema_evolution_contract.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-evolution-'));

  writeJson(path.join(tmp, 'config', 'primitive_catalog.json'), {
    schema_version: '1.2'
  });
  writeJson(path.join(tmp, 'config', 'capability_profile_schema.json'), {
    schema_version: '1.4'
  });

  const profilesDir = path.join(tmp, 'state', 'assimilation', 'capability_profiles', 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  writeJson(path.join(profilesDir, 'ok.json'), { profile_id: 'ok', schema_version: '1.4' });
  writeJson(path.join(profilesDir, 'old.json'), { profile_id: 'old', schema_version: '1.1' });

  const eventsPath = path.join(tmp, 'state', 'runtime', 'canonical_events', 'events.jsonl');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.writeFileSync(eventsPath, [
    JSON.stringify({ schema_version: '1.0', type: 'x' }),
    JSON.stringify({ schema_version: '1.2', type: 'y' })
  ].join('\n') + '\n', 'utf8');

  const policyPath = path.join(tmp, 'config', 'schema_evolution_policy.json');
  writeJson(policyPath, {
    schema_id: 'schema_evolution_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    default_n_minus_minor: 2,
    auto_migrate_minor_drift: true,
    max_auto_migrate_minor_delta: 6,
    latest_path: 'state/ops/schema_evolution/latest.json',
    receipts_path: 'state/ops/schema_evolution/receipts.jsonl',
    lanes: [
      {
        id: 'primitive_catalog',
        format: 'json',
        version_field: 'schema_version',
        target_version_ref: {
          path: 'client/config/primitive_catalog.json',
          json_path: 'schema_version'
        },
        target_paths: ['client/config/primitive_catalog.json'],
        n_minus_minor: 0,
        allow_missing_targets: false
      },
      {
        id: 'capability_profiles',
        format: 'json',
        version_field: 'schema_version',
        target_version_ref: {
          path: 'client/config/capability_profile_schema.json',
          json_path: 'schema_version'
        },
        target_paths: ['state/assimilation/capability_profiles/profiles'],
        n_minus_minor: 2,
        allow_missing_targets: false,
        max_depth: 3
      },
      {
        id: 'canonical_events',
        format: 'jsonl',
        version_field: 'schema_version',
        target_version: '1.2',
        target_paths: ['state/runtime/canonical_events/events.jsonl'],
        n_minus_minor: 1,
        allow_missing_targets: false
      }
    ]
  });

  const env = {
    ...process.env,
    SCHEMA_EVOLUTION_ROOT: tmp
  };

  const failRun = spawnSync(process.execPath, [
    script,
    'run',
    '--strict=1',
    '--apply=0',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.notStrictEqual(failRun.status, 0, 'verify-only should fail on incompatible versions');
  const failOut = parseJson(failRun.stdout);
  assert.ok(failOut && Number(failOut.failure_count || 0) > 0, 'expected failures in verify-only pass');

  const applyRun = spawnSync(process.execPath, [
    script,
    'run',
    '--strict=1',
    '--apply=1',
    `--policy=${policyPath}`
  ], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.strictEqual(applyRun.status, 0, applyRun.stderr || 'apply run should pass strict mode');
  const applyOut = parseJson(applyRun.stdout);
  assert.ok(applyOut && applyOut.ok === true, 'apply run should be ok');
  assert.ok(Number(applyOut.migration_count || 0) >= 2, 'expected migrations for profiles/events');

  const migratedProfile = JSON.parse(fs.readFileSync(path.join(profilesDir, 'old.json'), 'utf8'));
  assert.strictEqual(migratedProfile.schema_version, '1.4', 'profile should migrate to target schema');

  const eventRows = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(String(eventRows[0].schema_version), '1.2', 'event row should migrate to target schema');

  console.log('schema_evolution_contract.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`schema_evolution_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

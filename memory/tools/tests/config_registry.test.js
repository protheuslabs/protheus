#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'config_registry.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, value, 'utf8');
}

function run(args, env) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected stdout json');
  return JSON.parse(txt);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-registry-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const cfgRoot = path.join(workspaceRoot, 'config');
  const stateRoot = path.join(workspaceRoot, 'state');
  mkdirp(cfgRoot);
  mkdirp(stateRoot);

  writeJson(path.join(cfgRoot, 'alpha.json'), {
    version: '1.0',
    policy: { enabled: true, gate: { min: 1, max: 3 } }
  });
  writeJson(path.join(cfgRoot, 'beta.json'), {
    version: '2.0',
    policy: { enabled: false, gate: { min: 2, max: 4 } }
  });
  writeText(path.join(cfgRoot, 'broken.json'), '{not-json\n');

  writeJson(path.join(cfgRoot, 'canonical_policy.json'), {
    version: '1.0',
    mode: 'canonical'
  });
  writeJson(path.join(cfgRoot, 'config_aliases.json'), {
    version: '1.0',
    aliases: [
      {
        alias: 'config/legacy_policy_alias.json',
        canonical: 'config/canonical_policy.json',
        mode: 'copy'
      }
    ]
  });

  const policyPath = path.join(cfgRoot, 'config_registry_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scan_roots: ['config'],
    include_extensions: ['.json'],
    exclude_path_substrings: [],
    shape_depth: 3,
    max_files: 200,
    inventory_output_path: 'state/ops/config_registry/latest.json',
    inventory_history_jsonl_path: 'state/ops/config_registry/history.jsonl',
    consolidation: {
      enabled: true,
      min_shape_group_size: 2,
      max_candidates: 20
    },
    legacy_aliases: {
      enabled: true,
      alias_map_path: 'config/config_aliases.json',
      strict_canonical_exists: true
    }
  });

  const res = run(['run', '--apply-aliases=1', `--policy=${policyPath}`], {
    CONFIG_REGISTRY_POLICY_PATH: policyPath,
    CONFIG_REGISTRY_ROOT: workspaceRoot,
    HOME: workspaceRoot,
    PWD: workspaceRoot
  });
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  const payload = parseJson(res.stdout);
  assert.strictEqual(payload.ok, true, 'payload should be ok');
  assert.ok(Number(payload.metrics.files_scanned || 0) >= 4, 'should scan config files');
  assert.ok(Number(payload.metrics.invalid_json_files || 0) >= 1, 'invalid json should be detected');
  assert.ok(Array.isArray(payload.consolidation_candidates), 'consolidation candidates should be array');
  assert.ok(Number(payload.alias_sync && payload.alias_sync.synced || 0) >= 1, 'alias sync should apply at least one alias');

  const aliasPath = path.join(workspaceRoot, 'config', 'legacy_policy_alias.json');
  assert.ok(fs.existsSync(aliasPath), 'legacy alias file should be created');
  const canonicalBody = fs.readFileSync(path.join(workspaceRoot, 'config', 'canonical_policy.json'), 'utf8');
  const aliasBody = fs.readFileSync(aliasPath, 'utf8');
  assert.strictEqual(aliasBody, canonicalBody, 'alias file should mirror canonical file');

  console.log('config_registry.test.js: OK');
} catch (err) {
  console.error(`config_registry.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}

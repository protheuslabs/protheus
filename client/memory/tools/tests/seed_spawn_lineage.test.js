#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LINEAGE_SCRIPT = path.join(ROOT, 'systems', 'spawn', 'seed_spawn_lineage.js');

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

function run(args) {
  const proc = spawnSync(process.execPath, [LINEAGE_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-spawn-lineage-'));
  const policyPath = path.join(tmp, 'config', 'seed_spawn_lineage_policy.json');
  const memoryDir = path.join(tmp, 'memory', 'lineage');
  const adaptivePath = path.join(tmp, 'adaptive', 'lineage', 'seed_spawn_index.json');
  const contractsDir = path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'contracts');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    inheritance: {
      enabled_profiles: ['seed_spawn'],
      max_directives: 10,
      max_badges: 10,
      max_contract_refs: 10,
      allow_parent_route_tithe: true,
      max_parent_route_tithe_pct: 0.2
    },
    event_stream: {
      enabled: false,
      publish: false,
      stream: 'spawn.lineage'
    },
    paths: {
      memory_dir: memoryDir,
      adaptive_index_path: adaptivePath,
      contracts_dir: contractsDir,
      latest_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'latest.json'),
      history_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'history.jsonl'),
      receipts_path: path.join(tmp, 'state', 'spawn', 'seed_spawn_lineage', 'receipts.jsonl')
    }
  });

  let out = run([
    'configure',
    '--owner=jay',
    '--directives=guard,focus,alignment',
    '--badges=builder,operator',
    '--contracts=soul_1,soul_2',
    '--parent-route-tithe-pct=0.08',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'configure should pass');

  out = run([
    'preview',
    '--owner=jay',
    '--parent=proto_main',
    '--child=seed_alpha',
    '--profile=seed_spawn',
    '--apply=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'preview should pass');
  assert.ok(out.payload.lineage_contract, 'lineage contract should exist');
  assert.strictEqual(out.payload.lineage_contract.child_id, 'seed_alpha');
  assert.ok(Array.isArray(out.payload.lineage_contract.inherited_directives), 'directives should be array');

  const ownerPath = path.join(memoryDir, 'jay.json');
  assert.ok(fs.existsSync(ownerPath), 'owner config should be stored in client/memory/lineage');
  assert.ok(fs.existsSync(adaptivePath), 'adaptive lineage index should be written');
  assert.ok(fs.existsSync(path.join(contractsDir, 'seed_alpha.json')), 'applied lineage contract should be stored');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('seed_spawn_lineage.test.js: OK');
} catch (err) {
  console.error(`seed_spawn_lineage.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

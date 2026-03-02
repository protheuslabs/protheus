#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'backlog_registry.js');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeBacklog(root) {
  const backlog = [
    '# Upgrade Backlog',
    '',
    '| ID | Class | Wave | Status | Title | Problem | Acceptance | Dependencies |',
    '|---|---|---|---|---|---|---|---|',
    '| V3-RACE-111 | extension | V3 | queued | Canonical Backlog Registry + Generated Views | Manual edits drift. | Canonical source + generated views. | V3-RACE-CONF-003 |',
    '| V3-RACE-110 | primitive-upgrade | V3 | done | Memory Transport Abstraction Unification | Mixed transport semantics. | One transport abstraction and parity tests. | V3-RACE-023 |',
    '| V3-RACE-113 | hardening | V3 | blocked | Compatibility Tail Retirement | Dual TS/JS paths. | Retire compatibility tail after parity proof. | V2-001 |',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(root, 'UPGRADE_BACKLOG.md'), backlog, 'utf8');
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-registry-'));
  ensureDir(path.join(root, 'config'));
  ensureDir(path.join(root, 'docs', 'backlog_views'));
  ensureDir(path.join(root, 'state', 'ops'));
  writeBacklog(root);
  writeJson(path.join(root, 'config', 'backlog_registry_policy.json'), {
    version: '1.0',
    enabled: true,
    strict_default: true,
    active_statuses: ['queued', 'blocked'],
    archive_statuses: ['done'],
    paths: {
      backlog_path: path.join(root, 'UPGRADE_BACKLOG.md'),
      registry_path: path.join(root, 'config', 'backlog_registry.json'),
      active_view_path: path.join(root, 'docs', 'backlog_views', 'active.md'),
      archive_view_path: path.join(root, 'docs', 'backlog_views', 'archive.md'),
      latest_path: path.join(root, 'state', 'ops', 'backlog_registry', 'latest.json'),
      receipts_path: path.join(root, 'state', 'ops', 'backlog_registry', 'receipts.jsonl')
    }
  });
  return root;
}

function runCmd(root, args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKLOG_REGISTRY_POLICY_PATH: path.join(root, 'config', 'backlog_registry_policy.json')
    }
  });
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   BACKLOG REGISTRY TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('sync writes canonical registry + active/archive views', () => {
  const root = makeWorkspace();
  const r = runCmd(root, ['sync']);
  assert.strictEqual(r.status, 0, `sync failed: ${r.stderr}`);
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  const registryPath = path.join(root, 'config', 'backlog_registry.json');
  const activePath = path.join(root, 'docs', 'backlog_views', 'active.md');
  const archivePath = path.join(root, 'docs', 'backlog_views', 'archive.md');
  assert.ok(fs.existsSync(registryPath), 'registry missing');
  assert.ok(fs.existsSync(activePath), 'active view missing');
  assert.ok(fs.existsSync(archivePath), 'archive view missing');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.strictEqual(registry.row_count, 3);
  assert.ok(fs.readFileSync(activePath, 'utf8').includes('V3-RACE-111'), 'active view missing queued row');
  assert.ok(fs.readFileSync(archivePath, 'utf8').includes('V3-RACE-110'), 'archive view missing done row');
});

runTest('check strict fails when views drift', () => {
  const root = makeWorkspace();
  const sync = runCmd(root, ['sync']);
  assert.strictEqual(sync.status, 0, `sync failed: ${sync.stderr}`);

  const activePath = path.join(root, 'docs', 'backlog_views', 'active.md');
  fs.appendFileSync(activePath, '\n<!-- manual drift -->\n', 'utf8');

  const checkStrict = runCmd(root, ['check', '--strict=1']);
  assert.strictEqual(checkStrict.status, 2, 'strict check should fail on drift');
  const out = parseJson(checkStrict.stdout);
  assert.ok(out && out.ok === false, 'expected drift failure');
  assert.ok(Number(out.drift_count || 0) > 0, 'expected positive drift count');
});

runTest('check non-strict reports drift but exits zero', () => {
  const root = makeWorkspace();
  const sync = runCmd(root, ['sync']);
  assert.strictEqual(sync.status, 0, `sync failed: ${sync.stderr}`);

  const registryPath = path.join(root, 'config', 'backlog_registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.rows[0].title = 'tampered';
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  const check = runCmd(root, ['check', '--strict=0']);
  assert.strictEqual(check.status, 0, 'non-strict check should not fail');
  const out = parseJson(check.stdout);
  assert.ok(out && out.ok === false, 'expected drift report');
  assert.ok(Number(out.drift_count || 0) > 0, 'expected positive drift count');
});

if (failed) {
  process.exit(1);
}

console.log('✅ backlog_registry tests passed');

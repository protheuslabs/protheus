#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'relocatable_path_contract.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relocatable-path-contract-'));
  const sourceDir = path.join(tmp, 'source');
  const stateDir = path.join(tmp, 'state');
  const policyPath = path.join(tmp, 'config', 'relocatable_path_contract_policy.json');
  const sourceFile = path.join(sourceDir, 'sample.ts');
  const latestPath = path.join(stateDir, 'latest.json');
  const receiptsPath = path.join(stateDir, 'receipts.jsonl');
  const rewriteInventoryPath = path.join(stateDir, 'path_rewrite_inventory.json');

  writeText(
    sourceFile,
    [
      'const oldPath = "habits/scripts/external_eyes.js";',
      'const fallbackPath = "habits/routines/nightly_scan.js";',
      'export { oldPath, fallbackPath };'
    ].join('\n')
  );
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    scan: {
      include: [sourceDir],
      ext: ['.ts'],
      forbidden_patterns: ['/Users/forbidden-test-only/'],
      allowlist: []
    },
    paths: {
      latest_path: latestPath,
      receipts_path: receiptsPath,
      rewrite_inventory_path: rewriteInventoryPath
    }
  });

  let out = run(['check', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'check should pass');
  assert.ok(Number(out.payload.counts.rewrite_inventory_entries || 0) >= 2, 'rewrite inventory should include habits refs');
  assert.ok(fs.existsSync(rewriteInventoryPath), 'rewrite inventory file should exist');

  const inventory = JSON.parse(fs.readFileSync(rewriteInventoryPath, 'utf8'));
  assert.strictEqual(inventory.schema_id, 'relocatable_path_rewrite_inventory');
  assert.ok(
    inventory.entries.some((row) => (
      row.legacy_path === 'habits/scripts/external_eyes.js'
      && row.suggested_path === 'systems/adaptive/habits/scripts/external_eyes.js'
    )),
    'inventory should include deterministic suggested rewrite path'
  );

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.rewrite_inventory_path, 'status should include rewrite inventory path');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('relocatable_path_contract.test.js: OK');
} catch (err) {
  console.error(`relocatable_path_contract.test.js: FAIL: ${err.message}`);
  process.exit(1);
}


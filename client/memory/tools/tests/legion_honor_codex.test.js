#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'client/systems/honor/legion_honor_codex.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
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
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legion_honor_codex-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state');
  const checks = [
  {
    "id": "soul_bound_honor_ledger",
    "description": "Soul-bound honor ledger is active",
    "file_must_exist": "client/systems/honor/README.md"
  },
  {
    "id": "onchain_medal_bridge",
    "description": "Governed medal bridge references chain receipts"
  },
  {
    "id": "title_selection_surface",
    "description": "Public title selection surface active"
  },
  {
    "id": "red_legion_alias_migration",
    "description": "redteam to red_legion compatibility alias in place",
    "file_must_exist": "client/systems/red_legion/README.md"
  }
];

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    checks,
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl')
    }
  });

  let out = run(['mint', '--policy=' + policyPath, '--strict=1', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lane run should pass baseline checks');
  assert.strictEqual(Number(out.payload.check_count || 0), checks.length, 'all checks should be evaluated');

  out = run(['mint', '--policy=' + policyPath, '--strict=1', '--apply=1', '--fail-checks=soul_bound_honor_ledger']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when required check fails');
  assert.ok(out.payload && out.payload.ok === false, 'payload should indicate failed run');
  assert.ok(Array.isArray(out.payload.failed_checks) && out.payload.failed_checks.includes('soul_bound_honor_ledger'), 'failed check id should be listed');

  out = run(['status', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest artifact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('legion_honor_codex.test.js: OK');
} catch (err) {
  console.error('legion_honor_codex.test.js: FAIL: ' + err.message);
  process.exit(1);
}

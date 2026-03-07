#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'client/systems/fractal/warden/complexity_warden_meta_organ.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'complexity_warden_meta_organ-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state');
  const checks = [
  {
    "id": "warden_scoring_core",
    "description": "Complexity scoring core computes normalized dimensions",
    "file_must_exist": "client/systems/fractal/warden/README.md"
  },
  {
    "id": "complexity_budget_enforcement",
    "description": "Complexity budget and soul-tax enforcement active"
  },
  {
    "id": "organ_contract_validation",
    "description": "Fractal contract validation lane active"
  },
  {
    "id": "weekly_simplification_cycle",
    "description": "Scheduled simplification sprint lane active"
  }
];

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    checks,
    budget: {
      max_score: 1,
      warn_score: 0.99
    },
    scoring: {
      roots: ['systems', 'config', 'lib', 'habits'],
      max_files_baseline: 20000,
      max_dirs_baseline: 5000,
      max_scripts_baseline: 5000
    },
    paths: {
      state_path: path.join(stateDir, 'state.json'),
      latest_path: path.join(stateDir, 'latest.json'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      history_path: path.join(stateDir, 'history.jsonl')
    }
  });

  let out = run(['score', '--policy=' + policyPath, '--strict=1', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lane run should pass baseline checks');
  assert.strictEqual(Number(out.payload.check_count || 0), checks.length, 'all checks should be evaluated');

  out = run(['score', '--policy=' + policyPath, '--strict=1', '--apply=1', '--fail-checks=warden_scoring_core']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when required check fails');
  assert.ok(out.payload && out.payload.ok === false, 'payload should indicate failed run');
  assert.ok(Array.isArray(out.payload.failed_checks) && out.payload.failed_checks.includes('warden_scoring_core'), 'failed check id should be listed');

  out = run(['status', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest artifact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('complexity_warden_meta_organ.test.js: OK');
} catch (err) {
  console.error('complexity_warden_meta_organ.test.js: FAIL: ' + err.message);
  process.exit(1);
}

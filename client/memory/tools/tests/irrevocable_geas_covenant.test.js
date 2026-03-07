#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'client/systems/security/irrevocable_geas_covenant.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irrevocable_geas_covenant-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state');
  const checks = [
  {
    "id": "lineage_ban_registry",
    "description": "Compromised lineages recorded in irreversible ban registry"
  },
  {
    "id": "non_respawn_enforcement",
    "description": "Phoenix checks lineage bans before respawn"
  },
  {
    "id": "irreversible_self_destruct",
    "description": "Containment breach triggers irreversible self-destruct"
  },
  {
    "id": "override_recovery_policy",
    "description": "Recovery path requires explicit human override"
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

  let out = run(['ban', '--policy=' + policyPath, '--strict=1', '--apply=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lane run should pass baseline checks');
  assert.strictEqual(Number(out.payload.check_count || 0), checks.length, 'all checks should be evaluated');

  out = run(['ban', '--policy=' + policyPath, '--strict=1', '--apply=1', '--fail-checks=lineage_ban_registry']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail when required check fails');
  assert.ok(out.payload && out.payload.ok === false, 'payload should indicate failed run');
  assert.ok(Array.isArray(out.payload.failed_checks) && out.payload.failed_checks.includes('lineage_ban_registry'), 'failed check id should be listed');

  out = run(['status', '--policy=' + policyPath]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest artifact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('irrevocable_geas_covenant.test.js: OK');
} catch (err) {
  console.error('irrevocable_geas_covenant.test.js: FAIL: ' + err.message);
  process.exit(1);
}

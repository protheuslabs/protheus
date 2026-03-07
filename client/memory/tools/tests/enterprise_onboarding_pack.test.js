#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'enterprise_onboarding_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number.isFinite(proc.status) ? Number(proc.status) : 1, stdout: String(proc.stdout || ''), stderr: String(proc.stderr || ''), payload: parseJson(proc.stdout) };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-pack-'));
  const policyPath = path.join(tmp, 'config', 'enterprise_onboarding_pack_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'enterprise_onboarding_pack', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'enterprise_onboarding_pack', 'history.jsonl');

  const docText = [
    'Operator Platform Engineer External Contributor',
    'Day 0 Day 7 Day 30',
    'prerequisites safety gates success criteria bootstrap ci escalation'
  ].join('\n');
  writeText(path.join(tmp, 'docs', 'ONBOARDING_PLAYBOOK.md'), docText);
  writeText(path.join(tmp, 'docs', 'ENTERPRISE_ONBOARDING_PACK.md'), docText);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    onboarding_docs: ['client/docs/ONBOARDING_PLAYBOOK.md', 'client/docs/ENTERPRISE_ONBOARDING_PACK.md'],
    required_roles: ['Operator', 'Platform Engineer', 'External Contributor'],
    required_milestones: ['Day 0', 'Day 7', 'Day 30'],
    required_terms: ['prerequisites', 'safety gates', 'success criteria', 'bootstrap', 'ci', 'escalation'],
    paths: { latest_path: latestPath, history_path: historyPath }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('enterprise_onboarding_pack.test.js: OK');
} catch (err) {
  console.error(`enterprise_onboarding_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

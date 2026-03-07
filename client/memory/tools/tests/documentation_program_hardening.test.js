#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'documentation_program_hardening.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-hardening-'));
  const policyPath = path.join(tmp, 'config', 'documentation_program_hardening_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'documentation_program_hardening', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'documentation_program_hardening', 'history.jsonl');

  writeText(path.join(tmp, 'docs', 'DOCUMENTATION_PROGRAM_GOVERNANCE.md'), 'ownership model review cadence artifact tiers adr freshness process backlog + release linkage');
  writeText(path.join(tmp, 'docs', 'adr', 'README.md'), 'adr readme');
  writeText(path.join(tmp, 'docs', 'adr', 'TEMPLATE.md'), 'adr template');
  writeText(path.join(tmp, 'docs', 'adr', 'INDEX.md'), 'adr index');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    governance_doc: path.join(tmp, 'docs', 'DOCUMENTATION_PROGRAM_GOVERNANCE.md'),
    required_files: ['client/docs/adr/README.md', 'client/docs/adr/TEMPLATE.md', 'client/docs/adr/INDEX.md'],
    required_sections: ['ownership model', 'review cadence', 'artifact tiers', 'adr', 'freshness process', 'backlog + release linkage'],
    paths: { latest_path: latestPath, history_path: historyPath }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('documentation_program_hardening.test.js: OK');
} catch (err) {
  console.error(`documentation_program_hardening.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

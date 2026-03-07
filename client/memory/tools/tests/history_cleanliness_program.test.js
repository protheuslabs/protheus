#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'history_cleanliness_program.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-clean-'));
  const policyPath = path.join(tmp, 'config', 'history_cleanliness_program_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'history_cleanliness_program', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'history_cleanliness_program', 'history.jsonl');

  writeText(path.join(tmp, 'docs', 'HISTORY_CLEANLINESS.md'), 'append-only no force-push changelog');
  writeText(path.join(tmp, 'docs', 'RELEASE_DISCIPLINE_POLICY.md'), 'policy');
  writeText(path.join(tmp, 'CHANGELOG.md'), 'changelog');
  writeText(path.join(tmp, '.github', 'pull_request_template.md'), 'summary validation changelog');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_docs: ['client/docs/HISTORY_CLEANLINESS.md', 'client/docs/RELEASE_DISCIPLINE_POLICY.md', 'CHANGELOG.md', '.github/pull_request_template.md'],
    history_required_terms: ['append-only', 'no force-push', 'changelog'],
    pr_template_required_terms: ['summary', 'validation', 'changelog'],
    paths: { latest_path: latestPath, history_path: historyPath }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('history_cleanliness_program.test.js: OK');
} catch (err) {
  console.error(`history_cleanliness_program.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

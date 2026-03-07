#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'org_code_format_guard.js');

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
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'org-format-'));
  const policyPath = path.join(tmp, 'config', 'org_code_format_guard_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'org_code_format_guard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'org_code_format_guard', 'history.jsonl');

  writeText(path.join(tmp, 'systems', 'demo.ts'), 'const x = 1;\n');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    include_roots: ['systems'],
    include_ext: ['.ts'],
    exclude_dirs: ['.git', 'node_modules', 'state'],
    max_findings: 50,
    rules: {
      no_trailing_whitespace: true,
      eof_newline: true,
      no_crlf: true,
      no_tabs_for: ['.ts']
    },
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  let out = run(['check', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'clean file should pass');

  writeText(path.join(tmp, 'systems', 'demo.ts'), 'const x = 1; \n\tconst y = 2;');
  out = run(['check', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.notStrictEqual(out.status, 0, 'dirty file should fail strict mode');
  assert.strictEqual(out.payload.ok, false, 'dirty file should fail');
  assert.ok(out.payload.findings_count >= 1, 'findings should be reported');

  writeText(path.join(tmp, 'systems', 'demo.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
  out = run(['check', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.notStrictEqual(out.status, 0, 'CRLF file should fail strict mode');
  assert.strictEqual(out.payload.ok, false, 'CRLF file should fail');
  assert.ok(
    Array.isArray(out.payload.findings) && out.payload.findings.some((row) => row && row.rule === 'no_crlf_line_endings'),
    'CRLF rule finding should be reported'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('org_code_format_guard.test.js: OK');
} catch (err) {
  console.error(`org_code_format_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

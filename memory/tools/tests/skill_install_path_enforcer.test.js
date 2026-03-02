#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'skill_install_path_enforcer.js');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-path-enforcer-'));
  const policyPath = path.join(tmp, 'config', 'skill_install_path_enforcer_policy.json');
  const latestPath = path.join(tmp, 'state', 'security', 'skill_install_path_enforcer', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'security', 'skill_install_path_enforcer', 'history.jsonl');

  const badFile = path.join(tmp, 'systems', 'unsafe_install.ts');
  const goodFile = path.join(tmp, 'habits', 'scripts', 'safe_install.ts');

  writeText(
    badFile,
    "const { execSync } = require('child_process');\nexecSync('npx molthub install github:bad/skill');\n"
  );
  writeText(
    goodFile,
    "const { spawnSync } = require('child_process');\nspawnSync('node', ['habits/scripts/install_skill_safe.js', '--spec=github:ok/skill']);\n"
  );

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    scan_roots: ['systems', 'habits'],
    include_extensions: ['.js', '.ts'],
    skip_path_tokens: ['/tests/'],
    forbidden_patterns: [
      { id: 'direct', regex: 'molthub\\\\s+install' }
    ],
    required_wrapper_refs: ['habits/scripts/install_skill_safe.js'],
    outputs: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const env = {
    SKILL_INSTALL_ENFORCER_ROOT: tmp,
    SKILL_INSTALL_ENFORCER_POLICY_PATH: policyPath
  };

  let r = run(['check', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'strict run should fail when direct installer pattern is present');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === false, 'payload should fail');
  assert.strictEqual(Number(out.violation_count || 0), 1, 'exactly one violation expected');
  assert.ok(Array.isArray(out.violations) && String(out.violations[0].file || '').includes('unsafe_install.ts'));

  r = run(['check', '--strict=1', `--path=${goodFile}`], env);
  assert.strictEqual(r.status, 0, r.stderr || 'safe wrapper call should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'safe wrapper payload should pass');
  assert.ok(fs.existsSync(latestPath), 'latest output should be written');
  assert.ok(fs.existsSync(historyPath), 'history output should be written');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'status should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'status payload should be ok');

  console.log('skill_install_path_enforcer.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`skill_install_path_enforcer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

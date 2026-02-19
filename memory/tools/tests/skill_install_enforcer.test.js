#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, obj) {
  writeText(filePath, JSON.stringify(obj, null, 2));
}

function runScript(repoRoot, args) {
  const script = path.join(repoRoot, 'systems', 'security', 'skill_install_enforcer.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env: process.env });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRel = 'memory/tools/tests/temp_skill_install_enforcer';
  const tmpRoot = path.join(repoRoot, tmpRel);
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const wrapperRel = `${tmpRel}/install_skill_safe.js`;
  const quarantineRel = `${tmpRel}/skill_quarantine.js`;
  const unsafeRel = `${tmpRel}/unsafe_installer.js`;
  const policyPath = path.join(tmpRoot, 'policy.json');

  writeText(path.join(repoRoot, wrapperRel), `
const { inspectSpec, verifyPath } = require('./skill_quarantine');
inspectSpec();
verifyPath();
function trustFiles() {}
`);
  writeText(path.join(repoRoot, quarantineRel), `module.exports = { inspectSpec(){}, verifyPath(){} };`);
  writeText(path.join(repoRoot, unsafeRel), `
const { spawnSync } = require('child_process');
spawnSync('npx', ['molthub', 'install', 'github:bad/skill']);
`);

  writeJson(policyPath, {
    version: 'test',
    target_roots: [tmpRel],
    target_files: [],
    file_extensions: ['.js'],
    exclude_paths: [],
    allow_paths: [wrapperRel, quarantineRel],
    blocked_regexes: [
      '\\bnpx\\s+molthub\\s+install\\b',
      "\\bspawnSync\\s*\\(\\s*['\\\"]npx['\\\"][\\s\\S]{0,220}['\\\"]molthub['\\\"][\\s\\S]{0,220}['\\\"]install['\\\"]"
    ],
    required_wrapper_path: wrapperRel,
    required_wrapper_markers: ['inspectSpec(', 'verifyPath(', 'trustFiles('],
    required_quarantine_path: quarantineRel
  });

  // Unsafe path should fail strict mode.
  let r = runScript(repoRoot, ['run', `--policy=${policyPath}`, '--strict']);
  assert.notStrictEqual(r.status, 0, 'strict should fail when direct install pattern is present');
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, false);
  assert.ok(Array.isArray(out.violations) && out.violations.length >= 1, 'violation should be reported');

  // Remove unsafe installer and strict mode should pass.
  writeText(path.join(repoRoot, unsafeRel), `const cmd = "echo safe";`);
  r = runScript(repoRoot, ['run', `--policy=${policyPath}`, '--strict']);
  assert.strictEqual(r.status, 0, `strict should pass after remediation: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(Number(out.violation_count || 0), 0);
  assert.strictEqual(out.structure && out.structure.ok, true);

  console.log('skill_install_enforcer.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`skill_install_enforcer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

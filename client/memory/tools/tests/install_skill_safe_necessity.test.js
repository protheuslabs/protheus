#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'habits', 'scripts', 'install_skill_safe.js');
const TMP_DIR = path.join(REPO_ROOT, 'memory', 'tools', 'tests', 'temp_install_skill_safe_necessity');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function runInstall(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env
  });
}

function parseOut(r) {
  return JSON.parse(String(r.stdout || '{}'));
}

function main() {
  ensureDir(TMP_DIR);

  const badPath = path.join(TMP_DIR, 'bad_justification.json');
  writeJson(badPath, {
    problem: 'This looks cool and fun to try.',
    repeat_frequency: 1,
    expected_time_or_token_savings: 0,
    why_existing_habits_or_skills_insufficient: 'No strong reason.',
    risk_class: 'low'
  });

  const goodPath = path.join(TMP_DIR, 'good_justification.json');
  writeJson(goodPath, {
    problem: 'Repeated manual skill packaging checks are blocking daily workflow execution.',
    repeat_frequency: 8,
    expected_time_or_token_savings: 35,
    why_existing_habits_or_skills_insufficient: 'Existing habits do not cover skill manifest validation and trust pinning in one deterministic command.',
    risk_class: 'medium'
  });

  const blocked = runInstall([
    '--spec=github:org/repo/skill',
    '--dry-run',
    '--autonomous=1',
    `--justification-file=${badPath}`
  ]);
  assert.notStrictEqual(blocked.status, 0, `novelty-only justification should be blocked: ${blocked.stderr}`);
  const blockedOut = parseOut(blocked);
  assert.strictEqual(blockedOut.decision, 'blocked_necessity');
  assert.strictEqual(blockedOut.ok, false);
  assert.ok(Array.isArray(blockedOut.necessity && blockedOut.necessity.reasons), 'blocked response should include reasons');

  const allowed = runInstall([
    '--spec=github:org/repo/skill',
    '--dry-run',
    '--autonomous=1',
    `--justification-file=${goodPath}`
  ]);
  assert.strictEqual(allowed.status, 0, `valid necessity justification should pass gate: ${allowed.stderr}`);
  const allowedOut = parseOut(allowed);
  assert.strictEqual(allowedOut.decision, 'dry_run_plan');
  assert.ok(allowedOut.necessity && allowedOut.necessity.allowed === true, 'allowed response should include positive necessity evaluation');

  console.log('install_skill_safe_necessity.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`install_skill_safe_necessity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRel = 'memory/tools/tests/temp_arch_guard';
  const tmpRoot = path.join(repoRoot, tmpRel);
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const systemsRel = `${tmpRel}/systems`;
  const systemsRoot = path.join(repoRoot, systemsRel);
  mkDir(systemsRoot);

  writeText(path.join(systemsRoot, 'good.js'), 'const msg = "generic_system";\n');
  writeText(path.join(systemsRoot, 'bad.js'), 'const adapter = "moltbook_publish";\n');

  const policyPath = path.join(tmpRoot, 'policy.json');
  writeJson(policyPath, {
    version: 'test',
    target_roots: [systemsRel],
    file_extensions: ['.js'],
    exclude_paths: [],
    banned_tokens: ['moltbook'],
    allow_paths: []
  });

  const guard = require('../../../systems/security/architecture_guard.js');
  const policy = guard.loadPolicy(policyPath);
  const scan = guard.scanPolicy(policy);
  assert.strictEqual(scan.violation_count, 1);
  assert.strictEqual(scan.violations[0].token, 'moltbook');
  assert.strictEqual(scan.violations[0].file, `${systemsRel}/bad.js`);

  writeJson(policyPath, {
    version: 'test',
    target_roots: [systemsRel],
    file_extensions: ['.js'],
    exclude_paths: [],
    banned_tokens: ['moltbook'],
    allow_paths: [`${systemsRel}/bad.js`]
  });
  const policyAllow = guard.loadPolicy(policyPath);
  const scanAllow = guard.scanPolicy(policyAllow);
  assert.strictEqual(scanAllow.violation_count, 0);

  console.log('architecture_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`architecture_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

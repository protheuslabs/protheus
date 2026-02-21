#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  sealIntegrity,
  verifyIntegrity
} = require('../../../lib/security_integrity.js');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, obj) {
  writeText(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRel = 'memory/tools/tests/temp_security_integrity';
  const tmpRoot = path.join(repoRoot, tmpRel);
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const systemsSecurityRel = `${tmpRel}/systems/security`;
  const directivesRel = `${tmpRel}/config/directives`;
  const resolverRel = `${tmpRel}/lib/directive_resolver.js`;

  const guardPath = path.join(repoRoot, systemsSecurityRel, 'guard.js');
  const activePath = path.join(repoRoot, directivesRel, 'ACTIVE.yaml');
  const t0Path = path.join(repoRoot, directivesRel, 'T0_invariants.yaml');
  const resolverPath = path.join(repoRoot, resolverRel);

  writeText(guardPath, 'module.exports = { ok: true };\n');
  writeText(activePath, 'active_directives:\n  - id: T0_invariants\n    status: active\n');
  writeText(t0Path, 'metadata:\n  tier: 0\n');
  writeText(resolverPath, 'module.exports = {};\n');

  const policyPath = path.join(tmpRoot, 'policy.json');
  writeJson(policyPath, {
    version: 'test',
    target_roots: [systemsSecurityRel, directivesRel],
    target_extensions: ['.js', '.yaml'],
    protected_files: [resolverRel],
    exclude_paths: [],
    hashes: {}
  });

  const seal = sealIntegrity(policyPath, {
    approval_note: 'test baseline seal for integrity kernel',
    sealed_by: 'test'
  });
  assert.strictEqual(seal.ok, true);
  assert.strictEqual(seal.sealed_files, 4);

  const first = verifyIntegrity(policyPath);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.violations.length, 0);

  // Mutate a sealed file and confirm mismatch is detected.
  writeText(guardPath, 'module.exports = { ok: false };\n');
  const mismatch = verifyIntegrity(policyPath);
  assert.strictEqual(mismatch.ok, false);
  assert.ok(mismatch.violations.some(v => v.type === 'hash_mismatch' && v.file === `${systemsSecurityRel}/guard.js`));

  // Reseal and confirm clean state again.
  sealIntegrity(policyPath, {
    approval_note: 'refresh baseline after expected file edit',
    sealed_by: 'test'
  });
  const clean = verifyIntegrity(policyPath);
  assert.strictEqual(clean.ok, true);

  // Add a new protected-scope file and confirm it must be sealed.
  const newFile = path.join(repoRoot, systemsSecurityRel, 'new_gate.js');
  writeText(newFile, 'module.exports = { gate: true };\n');
  const unsealed = verifyIntegrity(policyPath);
  assert.strictEqual(unsealed.ok, false);
  assert.ok(unsealed.violations.some(v => v.type === 'unsealed_file' && v.file === `${systemsSecurityRel}/new_gate.js`));

  console.log('security_integrity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`security_integrity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

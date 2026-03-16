#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const VITEST_BIN = require.resolve('vitest/vitest.mjs');
const SUITE = [
  'tests/vitest/v6_memory_policy_validator.test.ts',
  'tests/vitest/v6_memory_session_isolation.test.ts',
  'tests/vitest/v6_memory_client_guard_integration.test.ts'
];

function runVitestSuite(extraArgs = []) {
  const args = ['run', '--config', 'vitest.config.ts'].concat(SUITE).concat(extraArgs);
  return spawnSync(process.execPath, [VITEST_BIN].concat(args), {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

function runLegacyCorpusAudit() {
  return spawnSync(
    process.execPath,
    ['tests/tooling/scripts/ci/legacy_client_memory_wrapper_audit.mjs', '--strict=1'],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  );
}

function normalizeResult(name, proc) {
  return {
    test: name,
    status: Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function main() {
  const argv = process.argv.slice(2);
  const includeLegacyAudit = argv.includes('--full-corpus');

  const results = [];
  const vitest = normalizeResult('vitest_memory_client_suite', runVitestSuite());
  results.push(vitest);

  if (includeLegacyAudit) {
    results.push(
      normalizeResult('legacy_client_memory_wrapper_audit', runLegacyCorpusAudit())
    );
  }

  for (const result of results) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  const failed = results.filter((row) => row.status !== 0);
  const payload = {
    ok: failed.length === 0,
    type: 'client_memory_ci_suite',
    total: results.length,
    failed: failed.length,
    failures: failed.map((row) => ({ test: row.test, status: row.status }))
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(payload.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  SUITE,
  runVitestSuite,
  runLegacyCorpusAudit
};

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../../..');
const LEGACY_DIR = path.resolve(ROOT, 'tests/client-memory-tools');
const BASELINE_PATH = path.resolve(__dirname, 'legacy_client_memory_wrapper_baseline.json');
const REQUIRED_VITEST_FILES = [
  'tests/vitest/v6_memory_policy_validator.test.ts',
  'tests/vitest/v6_memory_session_isolation.test.ts',
  'tests/vitest/v6_memory_client_guard_integration.test.ts'
];

function parseArgFlag(name) {
  const exact = `--${name}`;
  const keyed = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw === exact) return true;
    if (raw.startsWith(keyed)) {
      const value = raw.slice(keyed.length).trim().toLowerCase();
      return value === '1' || value === 'true' || value === 'yes' || value === 'on';
    }
  }
  return false;
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function classifyLegacyFiles(files) {
  const retired = [];
  const delegated = [];
  const assertionBased = [];

  for (const file of files) {
    const fullPath = path.resolve(LEGACY_DIR, file);
    const source = readUtf8(fullPath);
    if (source.includes('_legacy_retired_test_wrapper.js')) retired.push(file);
    if (source.includes('spawnSync(') && source.includes('.test.js')) delegated.push(file);
    if (/\bassert\b/.test(source)) assertionBased.push(file);
  }

  return { retired, delegated, assertionBased };
}

function loadBaseline() {
  const raw = readUtf8(BASELINE_PATH);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function checkVitestCoverage() {
  return REQUIRED_VITEST_FILES.map((relPath) => ({
    path: relPath,
    exists: fs.existsSync(path.resolve(ROOT, relPath)),
  }));
}

function buildPayload() {
  const files = fs
    .readdirSync(LEGACY_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
  const classified = classifyLegacyFiles(files);
  const vitestCoverage = checkVitestCoverage();

  return {
    ok: true,
    type: 'legacy_client_memory_wrapper_audit',
    generated_at: new Date().toISOString(),
    directory: path.relative(ROOT, LEGACY_DIR),
    counts: {
      total_test_files: files.length,
      retired_wrapper_files: classified.retired.length,
      delegated_wrapper_files: classified.delegated.length,
      assertion_based_files: classified.assertionBased.length,
    },
    vitest_required_files: vitestCoverage,
    sample: {
      retired_wrapper_files: classified.retired.slice(0, 10),
      delegated_wrapper_files: classified.delegated.slice(0, 10),
      assertion_based_files: classified.assertionBased.slice(0, 10),
    },
  };
}

function compareToBaseline(payload, baseline) {
  const failures = [];
  if (!baseline || typeof baseline !== 'object') {
    failures.push('missing_or_invalid_baseline');
    return failures;
  }
  const current = payload.counts;
  const expected = baseline.counts || {};

  if (current.total_test_files > Number(expected.total_test_files || 0)) {
    failures.push(`total_test_files_increased:${current.total_test_files}>${expected.total_test_files}`);
  }
  if (current.retired_wrapper_files > Number(expected.retired_wrapper_files || 0)) {
    failures.push(
      `retired_wrapper_files_increased:${current.retired_wrapper_files}>${expected.retired_wrapper_files}`,
    );
  }
  if (current.delegated_wrapper_files > Number(expected.delegated_wrapper_files || 0)) {
    failures.push(
      `delegated_wrapper_files_increased:${current.delegated_wrapper_files}>${expected.delegated_wrapper_files}`,
    );
  }
  if (current.assertion_based_files > Number(expected.assertion_based_files || 0)) {
    failures.push(`assertion_based_files_increased:${current.assertion_based_files}>${expected.assertion_based_files}`);
  }

  const missingVitest = payload.vitest_required_files.filter((row) => !row.exists).map((row) => row.path);
  if (missingVitest.length) {
    failures.push(`missing_required_vitest_files:${missingVitest.join(',')}`);
  }

  return failures;
}

function main() {
  const strict = parseArgFlag('strict');
  const payload = buildPayload();
  let failures = [];

  if (strict) {
    failures = compareToBaseline(payload, loadBaseline());
    payload.ok = failures.length === 0;
    payload.strict = true;
    payload.failures = failures;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(payload.ok ? 0 : 1);
}

main();

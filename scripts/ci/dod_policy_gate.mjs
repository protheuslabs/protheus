#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const STRICT = process.argv.includes('--strict=1');
const ARTIFACTS_DIR = resolve('artifacts');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function latestRoiArtifact() {
  const files = readdirSync(ARTIFACTS_DIR)
    .filter((name) => /^roi_top100_execution_\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (files.length === 0) {
    fail('dod_policy_gate: missing core/local/artifacts/roi_top100_execution_*.json');
  }
  return resolve(ARTIFACTS_DIR, files[files.length - 1]);
}

function globHasMatch(pattern) {
  try {
    const out = execSync(`rg --files -g "${pattern}" . | head -n 1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function evidenceExists(evidence) {
  if (!evidence || typeof evidence !== 'string') return false;
  if (evidence.includes('*')) return globHasMatch(evidence);
  return existsSync(resolve(evidence));
}

function main() {
  const roiPath = latestRoiArtifact();
  const payload = parseJson(roiPath);
  const implemented = Array.isArray(payload.implemented) ? payload.implemented : [];
  const validated = Array.isArray(payload.validated) ? payload.validated : [];

  const findings = [];

  implemented.forEach((item, idx) => {
    if (!item?.title || typeof item.title !== 'string') {
      findings.push(`implemented[${idx}] missing title`);
    }
    if (!item?.evidence || typeof item.evidence !== 'string') {
      findings.push(`implemented[${idx}] missing evidence`);
      return;
    }
    if (!evidenceExists(item.evidence)) {
      findings.push(`implemented[${idx}] evidence_not_found: ${item.evidence}`);
    }
  });

  validated.forEach((item, idx) => {
    if (item?.result !== 'existing-coverage-validated') {
      findings.push(
        `validated[${idx}] invalid_result: expected existing-coverage-validated, got ${item?.result ?? 'null'}`,
      );
    }
    if ((item?.status ?? '').toLowerCase() === 'done') {
      findings.push(`validated[${idx}] invalid_status_done_for_regression_only: ${item?.id ?? 'unknown'}`);
    }
  });

  const summary = {
    ok: findings.length === 0,
    type: 'dod_policy_gate',
    strict: STRICT,
    source: roiPath,
    implemented_count: implemented.length,
    validated_count: validated.length,
    findings_count: findings.length,
    findings,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (STRICT && findings.length > 0) {
    process.exit(2);
  }
}

main();

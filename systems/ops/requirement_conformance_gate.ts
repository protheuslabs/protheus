#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-CONF-003
 * Requirement conformance matrix + gate.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.REQUIREMENT_CONFORMANCE_GATE_POLICY_PATH
  ? path.resolve(process.env.REQUIREMENT_CONFORMANCE_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'requirement_conformance_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/requirement_conformance_gate.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/requirement_conformance_gate.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function normalizeList(v: unknown, maxLen = 220) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    backlog_path: 'UPGRADE_BACKLOG.md',
    matrix_path: 'config/requirement_conformance_matrix.json',
    required_external_ids: [],
    outputs: {
      latest_path: 'state/ops/requirement_conformance/latest.json',
      history_path: 'state/ops/requirement_conformance/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    backlog_path: resolvePath(raw.backlog_path, base.backlog_path),
    matrix_path: resolvePath(raw.matrix_path, base.matrix_path),
    required_external_ids: normalizeList(raw.required_external_ids || base.required_external_ids, 160),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function parseMatrix(matrixPath: string) {
  const matrix = readJson(matrixPath, null);
  if (!matrix || typeof matrix !== 'object') {
    return {
      ok: false,
      error: 'matrix_missing_or_invalid',
      schema_id: null,
      requirements: []
    };
  }
  const reqs = Array.isArray(matrix.requirements) ? matrix.requirements : [];
  return {
    ok: true,
    schema_id: cleanText(matrix.schema_id || '', 120) || null,
    schema_version: cleanText(matrix.schema_version || '', 40) || null,
    requirements: reqs
  };
}

function backlogContainsId(backlogText: string, id: string) {
  const needle = `| ${id} |`;
  return backlogText.includes(needle);
}

function runGate(policy: any) {
  if (!fs.existsSync(policy.backlog_path)) {
    return {
      ok: false,
      error: 'backlog_missing',
      backlog_path: rel(policy.backlog_path)
    };
  }
  const backlogText = fs.readFileSync(policy.backlog_path, 'utf8');
  const parsed = parseMatrix(policy.matrix_path);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      matrix_path: rel(policy.matrix_path),
      backlog_path: rel(policy.backlog_path)
    };
  }

  const rows = [];
  const presentExternalIds = new Set<string>();
  for (const raw of parsed.requirements) {
    const externalId = cleanText(raw && raw.external_requirement_id || '', 160);
    const canonicalId = cleanText(raw && raw.canonical_backlog_id || '', 80);
    const fileAnchors = normalizeList(raw && raw.file_anchors || [], 320);
    const evidenceTests = normalizeList(raw && raw.evidence_tests || [], 320);

    if (externalId) presentExternalIds.add(externalId);

    const canonicalInBacklog = !!(canonicalId && backlogContainsId(backlogText, canonicalId));
    const missingFiles = fileAnchors.filter((row) => !fs.existsSync(path.isAbsolute(row) ? row : path.join(ROOT, row)));
    const missingTests = evidenceTests.filter((row) => !fs.existsSync(path.isAbsolute(row) ? row : path.join(ROOT, row)));
    const violations = [];
    if (!externalId) violations.push('external_requirement_id_missing');
    if (!canonicalId) violations.push('canonical_backlog_id_missing');
    if (canonicalId && !canonicalInBacklog) violations.push('canonical_backlog_id_not_found');
    if (fileAnchors.length < 1) violations.push('file_anchor_missing');
    if (evidenceTests.length < 1) violations.push('evidence_test_missing');
    if (missingFiles.length) violations.push('file_anchor_not_found');
    if (missingTests.length) violations.push('evidence_test_not_found');

    rows.push({
      external_requirement_id: externalId || null,
      canonical_backlog_id: canonicalId || null,
      canonical_in_backlog: canonicalInBacklog,
      file_anchors: fileAnchors,
      evidence_tests: evidenceTests,
      missing_file_anchors: missingFiles,
      missing_evidence_tests: missingTests,
      ok: violations.length === 0,
      violations
    });
  }

  const unmappedRequired = policy.required_external_ids.filter((id: string) => !presentExternalIds.has(id));
  const failedRows = rows.filter((row) => row.ok !== true);
  const ok = failedRows.length === 0 && unmappedRequired.length === 0;

  return {
    ok,
    type: 'requirement_conformance_gate',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    backlog_path: rel(policy.backlog_path),
    matrix_path: rel(policy.matrix_path),
    matrix_schema_id: parsed.schema_id,
    matrix_schema_version: parsed.schema_version,
    requirement_count: rows.length,
    failed_requirements: failedRows.length,
    unmapped_required_external_ids: unmappedRequired,
    requirements: rows
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || args.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const policy = loadPolicy(args.policy || POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'requirement_conformance_gate_disabled' }, 1);

  if (cmd === 'run') {
    const strict = toBool(args.strict, policy.strict_default);
    const out = runGate(policy);
    out.strict = strict;
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.history_path, out);
    emit(out, strict && out.ok !== true ? 1 : 0);
  }
  if (cmd === 'status') {
    const latest = readJson(policy.outputs.latest_path, null);
    emit({
      ok: true,
      type: 'requirement_conformance_gate_status',
      ts: nowIso(),
      policy: {
        version: policy.version,
        strict_default: policy.strict_default,
        policy_path: rel(policy.policy_path)
      },
      latest
    });
  }

  usage();
  process.exit(1);
}

main();

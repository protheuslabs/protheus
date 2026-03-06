#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-FORT-006
 * Empty Fort integrity guard (no fabricated claims).
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.EMPTY_FORT_INTEGRITY_GUARD_POLICY_PATH
  ? path.resolve(process.env.EMPTY_FORT_INTEGRITY_GUARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'empty_fort_integrity_guard_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/empty_fort_integrity_guard.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/empty_fort_integrity_guard.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readText(filePath: string) {
  try {
    return fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_docs: [
      'docs/CLAIM_EVIDENCE_POLICY.md',
      'docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md',
      'docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'docs/RELEASE_DISCIPLINE_POLICY.md'
    ],
    release_surfaces: [
      'README.md',
      'docs/README.md',
      'docs/PUBLIC_OPERATOR_PROFILE.md',
      'docs/release/templates/release_plan.md'
    ],
    claim_terms: [
      'industry-leading',
      'proven at scale',
      'fully autonomous',
      'formally verified',
      'soc2',
      'compliant',
      '99.9%',
      'p95',
      'p99'
    ],
    evidence_terms: [
      'evidence',
      'receipt',
      'benchmark',
      'source:',
      'docs/',
      'state/'
    ],
    required_policy_terms: [
      'measurable',
      'security-sensitive',
      'required evidence',
      'prohibited patterns',
      'review gate'
    ],
    required_checklist_terms: [
      'claim class',
      'evidence link',
      'owner',
      'verification date',
      'status'
    ],
    paths: {
      latest_path: 'state/ops/empty_fort_integrity_guard/latest.json',
      history_path: 'state/ops/empty_fort_integrity_guard/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    required_docs: Array.isArray(raw.required_docs) && raw.required_docs.length
      ? raw.required_docs.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_docs,
    release_surfaces: Array.isArray(raw.release_surfaces) && raw.release_surfaces.length
      ? raw.release_surfaces.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.release_surfaces,
    claim_terms: Array.isArray(raw.claim_terms) && raw.claim_terms.length
      ? raw.claim_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.claim_terms,
    evidence_terms: Array.isArray(raw.evidence_terms) && raw.evidence_terms.length
      ? raw.evidence_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.evidence_terms,
    required_policy_terms: Array.isArray(raw.required_policy_terms) && raw.required_policy_terms.length
      ? raw.required_policy_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_policy_terms,
    required_checklist_terms: Array.isArray(raw.required_checklist_terms) && raw.required_checklist_terms.length
      ? raw.required_checklist_terms.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_checklist_terms,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function scanClaimEvidence(surfaceRel: string, surfaceText: string, claimTerms: string[], evidenceTerms: string[]) {
  const findings: AnyObj[] = [];
  const lines = String(surfaceText || '').split('\n');
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    const hit = claimTerms.find((term: string) => lower.includes(term));
    if (!hit) return;
    const hasMarkdownLink = /\[[^\]]+\]\([^)]+\)/.test(line);
    const hasEvidenceToken = evidenceTerms.some((token: string) => lower.includes(token));
    if (!hasMarkdownLink && !hasEvidenceToken) {
      findings.push({
        file: surfaceRel,
        line: idx + 1,
        claim_term: hit,
        text: cleanText(line, 220)
      });
    }
  });
  return findings;
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) return { ok: true, type: 'empty_fort_integrity_guard', ts: nowIso(), result: 'disabled_by_policy' };

  const missingDocs = policy.required_docs
    .map((relPath: string) => ({ rel: relPath, abs: path.join(ROOT, relPath) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const policyText = readText(path.join(ROOT, 'docs/CLAIM_EVIDENCE_POLICY.md')).toLowerCase();
  const checklistText = readText(path.join(ROOT, 'docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md')).toLowerCase();
  const missingPolicyTerms = policy.required_policy_terms.filter((term: string) => !policyText.includes(term));
  const missingChecklistTerms = policy.required_checklist_terms.filter((term: string) => !checklistText.includes(term));

  const claimEvidenceFindings = policy.release_surfaces
    .flatMap((surfaceRel: string) => {
      const text = readText(path.join(ROOT, surfaceRel));
      return scanClaimEvidence(surfaceRel, text, policy.claim_terms, policy.evidence_terms);
    });

  const checks = {
    required_docs_present: missingDocs.length === 0,
    claim_policy_terms_present: missingPolicyTerms.length === 0,
    checklist_terms_present: missingChecklistTerms.length === 0,
    release_claims_have_evidence: claimEvidenceFindings.length === 0
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'empty_fort_integrity_guard',
    lane_id: 'V4-FORT-006',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_policy_terms: missingPolicyTerms,
    missing_checklist_terms: missingChecklistTerms,
    claim_evidence_findings: claimEvidenceFindings,
    verification_receipt_id: `fort_integrity_${stableHash(JSON.stringify({
      missingDocs,
      missingPolicyTerms,
      missingChecklistTerms,
      claimEvidenceFindings
    }), 14)}`
  };
}

function cmdVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, true);
  const out = verify(policy);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, { ts: out.ts, type: out.type, ok: out.ok, blocking_checks: out.blocking_checks });
  emit({ ...out, policy_path: rel(policy.policy_path), latest_path: rel(policy.paths.latest_path) }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  emit({
    ok: true,
    type: 'empty_fort_integrity_guard_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    policy_path: rel(policy.policy_path)
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || ['help', '--help', '-h'].includes(cmd)) {
    usage();
    process.exit(0);
  }
  if (cmd === 'verify' || cmd === 'run') return cmdVerify(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();

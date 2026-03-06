#!/usr/bin/env node
'use strict';
export {};

/**
 * Constitution hooks for fractal mutation proposals.
 *
 * These checks are intentionally conservative; mutation candidates that do not
 * satisfy them are filtered out before shadow trials.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  clampInt,
  stableHash
} = require('../../lib/queued_backlog_runtime');

const CONSTITUTION_PATH = path.join(ROOT, 'AGENT-CONSTITUTION.md');

function defaultConstitutionPolicy() {
  return {
    version: '1.0',
    require_constitution_file: true,
    max_summary_chars: 720,
    max_patch_preview_chars: 8000,
    max_risk_tier: 5,
    blocked_token_patterns: [
      /rm\s+-rf/i,
      /disable[_ -]?guard/i,
      /bypass[_ -]?(approval|gate|policy)/i,
      /skip[_ -]?(approval|gate|policy|constitution)/i,
      /exfiltrat(e|ion)/i,
      /leak[_ -]?secret/i,
      /hard[-_ ]?code[_ -]?token/i
    ],
    blocked_path_patterns: [
      /(^|\/)\.git(\/|$)/,
      /(^|\/)secrets?(\/|$)/,
      /(^|\/)node_modules(\/|$)/,
      /(^|\/)\.env/i
    ],
    allowed_path_prefixes: ['systems/', 'config/', 'state/', 'docs/']
  };
}

function normalizeCandidate(candidate: any) {
  const src = candidate && typeof candidate === 'object' ? candidate : {};
  const id = normalizeToken(src.id || src.candidate_id || `mut_${Date.now()}`, 120) || `mut_${Date.now()}`;
  const summary = cleanText(src.summary || src.patch_intent || src.title || '', 1200);
  const patchPreview = cleanText(src.patch_preview || src.patch || src.diff || '', 12000);
  const targetPathRaw = cleanText(src.target_path || src.file || '', 520);
  const riskTier = clampInt(src.risk_tier, 0, 9, 2);
  return {
    id,
    summary,
    patch_preview: patchPreview,
    target_path: targetPathRaw,
    risk_tier: riskTier,
    raw: src
  };
}

function normalizeRelPath(targetPathRaw: string) {
  if (!targetPathRaw) return '';
  const abs = path.isAbsolute(targetPathRaw)
    ? path.resolve(targetPathRaw)
    : path.join(ROOT, targetPathRaw);
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function evaluateMutation(candidate: any, options: any = {}) {
  const policy = {
    ...defaultConstitutionPolicy(),
    ...(options && typeof options === 'object' ? options.policy || {} : {})
  };
  const normalized = normalizeCandidate(candidate);
  const relTarget = normalizeRelPath(normalized.target_path);
  const constitutionExists = fs.existsSync(CONSTITUTION_PATH)
    && fs.statSync(CONSTITUTION_PATH).size > 0;

  const mergedText = `${normalized.id} ${normalized.summary} ${normalized.patch_preview}`;
  const blockedTokenHits = (policy.blocked_token_patterns || [])
    .filter((expr: RegExp) => expr instanceof RegExp && expr.test(mergedText))
    .map((expr: RegExp) => String(expr));

  const blockedPathHits = (policy.blocked_path_patterns || [])
    .filter((expr: RegExp) => expr instanceof RegExp && expr.test(relTarget))
    .map((expr: RegExp) => String(expr));

  const allowedByPrefix = !relTarget
    ? false
    : (policy.allowed_path_prefixes || []).some((prefix: string) => relTarget.startsWith(String(prefix || '')));

  const checks = {
    constitution_present: !policy.require_constitution_file || constitutionExists,
    token_safety: blockedTokenHits.length === 0,
    target_path_safe: blockedPathHits.length === 0,
    target_path_allowed: allowedByPrefix,
    summary_size_ok: normalized.summary.length <= Number(policy.max_summary_chars || 720),
    patch_preview_size_ok: normalized.patch_preview.length <= Number(policy.max_patch_preview_chars || 8000),
    risk_tier_ok: normalized.risk_tier <= Number(policy.max_risk_tier || 5)
  };

  const reasons = [];
  if (!checks.constitution_present) reasons.push('constitution_missing');
  if (!checks.token_safety) reasons.push('blocked_token_pattern');
  if (!checks.target_path_safe) reasons.push('blocked_target_path');
  if (!checks.target_path_allowed) reasons.push('target_path_not_allowlisted');
  if (!checks.summary_size_ok) reasons.push('summary_too_large');
  if (!checks.patch_preview_size_ok) reasons.push('patch_preview_too_large');
  if (!checks.risk_tier_ok) reasons.push('risk_tier_exceeds_policy');

  const pass = Object.values(checks).every(Boolean);
  const constitutionHash = constitutionExists
    ? stableHash(fs.readFileSync(CONSTITUTION_PATH, 'utf8'), 40)
    : null;

  return {
    pass,
    ts: nowIso(),
    policy_version: cleanText(policy.version || '1.0', 24) || '1.0',
    candidate_id: normalized.id,
    target_path: relTarget || null,
    risk_tier: normalized.risk_tier,
    checks,
    reasons,
    blocked_token_hits: blockedTokenHits,
    blocked_path_hits: blockedPathHits,
    constitution_hash: constitutionHash
  };
}

function ensureMutationAllowed(candidate: any, options: any = {}) {
  const evaluation = evaluateMutation(candidate, options);
  if (!evaluation.pass) {
    const reason = (evaluation.reasons || []).join(',') || 'constitution_checks_failed';
    const err = new Error(`mutation_blocked:${reason}`);
    (err as any).evaluation = evaluation;
    throw err;
  }
  return evaluation;
}

module.exports = {
  defaultConstitutionPolicy,
  evaluateMutation,
  ensureMutationAllowed
};

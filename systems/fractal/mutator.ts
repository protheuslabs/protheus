#!/usr/bin/env node
'use strict';
export {};

/**
 * Fractal mutator lane.
 *
 * Generates bounded mutation candidates from critic output. Candidate generation
 * is deterministic by design to keep governance and replayability stable.
 */

const {
  nowIso,
  cleanText,
  normalizeToken,
  clampInt,
  stableHash
} = require('../../lib/queued_backlog_runtime');
const constitutionHooks = require('./constitution_hooks');

function normalizeRiskTier(raw: unknown) {
  const token = normalizeToken(raw || '', 24);
  if (token === 'low') return 1;
  if (token === 'medium') return 2;
  if (token === 'high') return 3;
  if (token === 'critical') return 4;
  const n = Number(raw);
  if (Number.isFinite(n)) return clampInt(n, 0, 9, 2);
  return 2;
}

function materializeCandidate(domain: any, critique: any, idx: number) {
  const domainId = normalizeToken(domain && domain.id || `domain_${idx + 1}`, 80) || `domain_${idx + 1}`;
  const targetPath = cleanText(domain && domain.target_path || '', 520);
  const summary = cleanText(
    domain && domain.summary
    || `Mutation candidate for ${domainId}`,
    320
  );
  const riskTier = normalizeRiskTier(domain && domain.risk_tier);
  const seed = `${domainId}|${targetPath}|${summary}|${critique && critique.ts || nowIso()}`;
  const id = `frm_${stableHash(seed, 14)}`;

  return {
    id,
    candidate_id: id,
    domain_id: domainId,
    target_path: targetPath,
    summary,
    patch_intent: cleanText(`fractal_mutation:${domainId}:${summary}`, 520),
    patch_preview: cleanText(
      `// candidate=${id}\n// domain=${domainId}\n// target=${targetPath}\n// intent=${summary}`,
      1200
    ),
    risk_tier: riskTier,
    created_at: nowIso(),
    critique_confidence: Number(critique && critique.confidence || 0)
  };
}

function generate(critique: any, options: any = {}) {
  const maxMutations = clampInt(options.maxMutations, 1, 12, 3);
  const respectConstitution = options.respectConstitution !== false;

  const domains = Array.isArray(critique && critique.domains)
    ? critique.domains
    : [];

  const candidates = [];
  for (let i = 0; i < domains.length; i += 1) {
    if (candidates.length >= maxMutations) break;
    const candidate: any = materializeCandidate(domains[i], critique, i);

    if (respectConstitution) {
      const constitution = constitutionHooks.evaluateMutation(candidate, options);
      candidate.constitution = constitution;
      if (!constitution.pass) continue;
    }

    candidates.push(candidate);
  }

  return candidates;
}

module.exports = {
  generate,
  normalizeRiskTier
};

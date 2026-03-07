'use strict';

const PLACEHOLDER_TYPES = new Set([
  '',
  'unknown',
  'new',
  'queued',
  'pending',
  'proposal',
  'item',
  'generic'
]);

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeTypeKey(v) {
  const raw = normalizeText(v).toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function isUsableType(v) {
  const key = normalizeTypeKey(v);
  if (!key) return false;
  return !PLACEHOLDER_TYPES.has(key);
}

function extractSourceEyeId(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = normalizeText(meta.source_eye);
  if (direct) return direct;

  const evidence = Array.isArray(p.evidence) ? p.evidence : [];
  for (const row of evidence) {
    const ref = normalizeText(row && row.evidence_ref);
    if (!ref) continue;
    const match = ref.match(/\beye:([^\s|]+)/i);
    if (match && normalizeText(match[1])) return normalizeText(match[1]);
  }
  return '';
}

function inferTypeFromSignals(sourceEye, textBlob) {
  const eye = normalizeTypeKey(sourceEye);
  const text = String(textBlob || '').toLowerCase();

  if (eye === 'directive_pulse' || eye === 'directive_compiler') return 'directive_clarification';
  if (eye === 'local_state_fallback' || eye === 'local_state_digest' || eye === 'tier1_exception') return 'local_state_fallback';
  if (eye.includes('moltbook') || eye.includes('upwork') || eye.includes('bird_x') || eye.includes('x_')) return 'external_intel';

  const hasCollectorSignal = /\b(collector|eye|sensor|feed|ingest|crawler|scrap|parser)\b/.test(text);
  const hasRepairSignal = /\b(fail|failure|error|timeout|retry|recover|restor|remediation|broken|degraded|down|fix)\b/.test(text);
  if (hasCollectorSignal && hasRepairSignal) return 'collector_remediation';

  if (/\b(directive|objective|tier|scope|clarif|decompose|lineage)\b/.test(text)) return 'directive_clarification';
  if (/\b(campaign|strategy|portfolio|sequenc|roadmap|big[-\\s]?bet)\b/.test(text)) return 'strategy';
  if (/\b(opportunity|outreach|lead|sales|bizdev|revenue|freelance|contract|gig|client|rfp|reply|interview|proposal draft)\b/.test(text)) {
    return 'external_intel';
  }
  if (/\b(governance|routing|autonomy|spine|memory|reflex|spawn|security|integrity|queue|budget|attestation)\b/.test(text)) {
    return 'local_state_fallback';
  }
  if (eye && eye !== 'unknown_eye') return 'external_intel';
  return 'local_state_fallback';
}

function classifyProposalType(proposal, opts = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};

  const directCandidates = [
    { source: 'proposal.type', value: p.type },
    { source: 'meta.type', value: meta.type },
    { source: 'fallback_type', value: opts.fallback_type }
  ];
  for (const row of directCandidates) {
    if (!isUsableType(row.value)) continue;
    return {
      type: normalizeTypeKey(row.value),
      inferred: false,
      source: String(row.source || 'proposal.type')
    };
  }

  const sourceEye = extractSourceEyeId(p) || normalizeText(opts.source_eye);
  const textBlob = [
    p.title,
    p.summary,
    p.notes,
    p.suggested_next_command,
    p.expected_impact,
    meta.trigger,
    meta.normalized_objective,
    meta.normalized_expected_outcome,
    meta.normalized_validation_metric
  ].map(normalizeText).filter(Boolean).join(' ');
  const inferred = inferTypeFromSignals(sourceEye, textBlob);
  return {
    type: normalizeTypeKey(inferred) || 'local_state_fallback',
    inferred: true,
    source: sourceEye ? `infer:${sourceEye}` : 'infer:proposal_text'
  };
}

module.exports = {
  classifyProposalType,
  extractSourceEyeId,
  normalizeTypeKey
};

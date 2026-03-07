#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function sha16(v: unknown) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, 16);
}

function normalizeArray(v: unknown) {
  return Array.isArray(v) ? v : [];
}

function extractHighlights(envelope: any) {
  const out: string[] = [];
  const attentionEvents = normalizeArray(envelope && envelope.attention && envelope.attention.events);
  for (const row of attentionEvents) {
    const event = row && row.event && typeof row.event === 'object' ? row.event : {};
    const summary = cleanText(event.summary || event.source_type || event.type || '', 180);
    if (summary) out.push(summary);
  }

  const degradedReason = cleanText(envelope && envelope.attention && envelope.attention.degraded_reason, 180);
  if (degradedReason) out.push(`attention_degraded:${degradedReason}`);

  const spineSource = cleanText(
    envelope && envelope.spine_status && (envelope.spine_status.source_type || envelope.spine_status.type || ''),
    160
  );
  const spineSummary = cleanText(
    envelope && envelope.spine_status && (envelope.spine_status.summary || envelope.spine_status.last_error || ''),
    180
  );
  if (spineSummary) out.push(spineSummary);
  else if (spineSource) out.push(spineSource);

  const dopamineReasons = normalizeArray(
    envelope && envelope.dopamine_status && envelope.dopamine_status.breach_reasons
  )
    .map((entry: unknown) => cleanText(entry, 100))
    .filter(Boolean);
  if (dopamineReasons.length) {
    out.push(`dopamine_breach:${dopamineReasons.slice(0, 3).join('|')}`);
  }

  return out.filter(Boolean);
}

function classifyKind(text: string) {
  const lower = String(text || '').toLowerCase();
  if (
    lower.includes('blocked')
    || lower.includes('deny')
    || lower.includes('failed')
    || lower.includes('manual_trigger')
    || lower.includes('gate')
  ) return 'decision';
  if (
    lower.includes('directive')
    || lower.includes('objective')
    || lower.includes('t1')
    || lower.includes('campaign')
    || lower.includes('strategy')
  ) return 'directive';
  return 'insight';
}

function deriveEdges(envelope: any) {
  const edges = new Set<string>();
  if (envelope && envelope.attention) edges.add('attention_queue');
  if (envelope && envelope.spine_status) edges.add('spine');
  if (envelope && envelope.persona_status) edges.add('persona_ambient');
  if (envelope && envelope.dopamine_status) edges.add('dopamine_ambient');
  if (envelope && envelope.memory_status) edges.add('memory_ambient');
  return Array.from(edges);
}

function synthesizeEnvelope(envelope: any) {
  if (!envelope || typeof envelope !== 'object') return null;
  const highlights = extractHighlights(envelope);
  if (highlights.length === 0) return null;
  const key = highlights[0];
  const kind = classifyKind(key);
  const ts = cleanText(envelope.ts || new Date().toISOString(), 64) || new Date().toISOString();
  const date = ts.slice(0, 10);
  const nodeId = `conversation-eye-${sha16(`${ts}|${key}`)}`;
  const title = `[Conversation Eye] ${key}`.slice(0, 180);
  const preview = cleanText(
    `kind=${kind}; highlights=${highlights.slice(0, 3).join(' | ')}; envelope_sequence=${Number(envelope.sequence || 0) || 0}`,
    240
  );
  const tags = ['conversation', 'decision', 'insight', 'directive', 't1'];
  const edgesTo = deriveEdges(envelope);
  return {
    node_id: nodeId,
    node_kind: kind,
    node_tags: tags,
    edges_to: edgesTo,
    ts,
    date,
    title,
    preview
  };
}

module.exports = {
  synthesizeEnvelope
};

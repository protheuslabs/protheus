#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function summarizeFailures(results: AnyObj[] = []) {
  const failed = results.filter((row) => row && row.pass === false);
  const critical = failed.filter((row) => {
    const sev = String(row && row.severity || '').trim().toLowerCase();
    return sev === 'critical' || sev === 'high';
  });
  const topReasons = new Map<string, number>();
  for (const row of failed) {
    const hits = Array.isArray(row && row.unsafe_hits) ? row.unsafe_hits : [];
    if (!hits.length) {
      const key = 'heuristic_unsafe';
      topReasons.set(key, Number(topReasons.get(key) || 0) + 1);
      continue;
    }
    for (const hit of hits.slice(0, 8)) {
      const key = normalizeToken(hit, 120) || 'unsafe_pattern';
      topReasons.set(key, Number(topReasons.get(key) || 0) + 1);
    }
  }
  return {
    failed_count: failed.length,
    critical_count: critical.length,
    top_reasons: Array.from(topReasons.entries())
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
  };
}

function distillWisdom(input: AnyObj = {}) {
  const mode = String(input.mode || 'peacetime').trim().toLowerCase();
  const results = Array.isArray(input.results) ? input.results : [];
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const failureSummary = summarizeFailures(results);
  const baseNode = {
    node_id: `redteam_wisdom_${crypto.randomBytes(6).toString('hex')}`,
    ts: nowIso(),
    mode,
    confidence: Number(input.red_confidence || 0),
    first_principle: '',
    evidence: {
      selected_cases: Number(summary.selected_cases || 0),
      executed_cases: Number(summary.executed_cases || 0),
      fail_cases: Number(summary.fail_cases || 0),
      critical_fail_cases: Number(summary.critical_fail_cases || 0),
      failure_summary: failureSummary
    }
  };
  if (mode === 'war') {
    baseNode.first_principle = 'Escalate to containment only after independent consensus across helix, sentinel, and confidence gates.';
  } else if (failureSummary.failed_count > 0) {
    baseNode.first_principle = 'Repeated unsafe-response motifs should tighten probe corpus and hardening gates before promotion.';
  } else {
    baseNode.first_principle = 'Sustained friendly probing with low false positives increases defensive readiness without operational disruption.';
  }
  return {
    ok: true,
    node: baseNode,
    markdown: [
      '# Red Team Wisdom',
      '',
      `- Mode: \`${mode}\``,
      `- Principle: ${baseNode.first_principle}`,
      `- Evidence: executed=\`${baseNode.evidence.executed_cases}\` fail=\`${baseNode.evidence.fail_cases}\` critical=\`${baseNode.evidence.critical_fail_cases}\``
    ].join('\n')
  };
}

module.exports = {
  distillWisdom
};

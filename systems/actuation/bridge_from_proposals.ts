#!/usr/bin/env node
'use strict';

/**
 * Deterministic bridge:
 * proposal metadata hints -> meta.actuation payload
 *
 * Usage:
 *   node systems/actuation/bridge_from_proposals.js run [YYYY-MM-DD] [--dry-run]
 *   node systems/actuation/bridge_from_proposals.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = process.env.ACTUATION_BRIDGE_PROPOSALS_DIR
  ? path.resolve(process.env.ACTUATION_BRIDGE_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');

function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/bridge_from_proposals.js run [YYYY-MM-DD] [--dry-run]');
  console.log('  node systems/actuation/bridge_from_proposals.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normalizeText(x)).filter(Boolean);
}

function writeJsonAtomic(fp, obj) {
  const tmp = `${fp}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function inferKindFromTitle(title) {
  const m = String(title || '').match(/\[Actuation:([a-zA-Z0-9_-]+)\]/);
  return m ? m[1] : null;
}

function normalizeParams(v) {
  return v && typeof v === 'object' ? v : {};
}

function requiresActionSpecContract(proposal) {
  if (!proposal || typeof proposal !== 'object') return false;
  const id = String(proposal.id || '').toUpperCase();
  if (/^(PRP|EYE|CSG|COLLECTOR|INFRA)-/.test(id)) return true;
  if (String(proposal.type || '').toLowerCase() === 'actuation_task') return true;
  if (String(proposal.suggested_next_command || '').trim()) return true;
  if (Array.isArray(proposal.validation) && proposal.validation.length > 0) return true;
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  return !!(
    meta.relevance_score != null
    || meta.signal_quality_score != null
    || meta.actionability_score != null
    || meta.composite_eligibility_score != null
  );
}

function inferTargetFromProposal(p) {
  const meta = p && p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = normalizeText(meta.action_spec_target || '');
  if (direct) return direct.slice(0, 180);
  const eye = normalizeText(meta.source_eye || '');
  if (eye) return `eye:${eye}`.slice(0, 180);
  const evidence = Array.isArray(p && p.evidence) ? p.evidence : [];
  for (const row of evidence) {
    const ref = normalizeText(row && row.evidence_ref);
    if (ref) return ref.slice(0, 180);
  }
  const type = normalizeText(p && p.type || 'proposal').toLowerCase() || 'proposal';
  const id = normalizeText(p && p.id || 'unknown');
  return `${type}:${id}`.slice(0, 180);
}

function fallbackSuccessCriteria(verifyRows) {
  const rows = asStringArray(verifyRows);
  const out = [];
  for (const row of rows.slice(0, 3)) {
    out.push({
      metric: /kpi|rate|count|latency|error|uptime|coverage|artifact|receipt|reply|interview|target|metric/i.test(row)
        ? 'validation_metric'
        : 'validation_check',
      target: row.slice(0, 140),
      horizon: /\b(\d+\s*(h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes)|daily|weekly|monthly)\b/i.test(row)
        ? 'as specified'
        : 'next run'
    });
  }
  if (out.length === 0) {
    out.push({
      metric: 'verification_checks',
      target: 'all action_spec.verify checks pass with receipt evidence',
      horizon: 'next run'
    });
  }
  return out;
}

function normalizeSuccessCriteria(raw, verifyRows) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of src) {
    if (!row) continue;
    if (typeof row === 'string') {
      const text = normalizeText(row);
      if (!text) continue;
      out.push({ metric: 'validation_check', target: text.slice(0, 140), horizon: 'next run' });
      continue;
    }
    if (typeof row === 'object') {
      const metric = normalizeText(row.metric || row.name || 'validation_check').slice(0, 48);
      const target = normalizeText(row.target || row.threshold || row.description || row.goal);
      if (!target) continue;
      const horizon = normalizeText(row.horizon || row.window || row.by || 'next run').slice(0, 48);
      out.push({ metric, target: target.slice(0, 140), horizon });
    }
  }
  if (out.length > 0) return out.slice(0, 4);
  return fallbackSuccessCriteria(verifyRows);
}

function normalizeActionSpec(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const direct = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : null;
  const nested = meta.action_spec && typeof meta.action_spec === 'object' ? meta.action_spec : null;
  const src = direct || nested || {};

  const objective = normalizeText(
    src.objective
    || meta.normalized_objective
    || p.summary
    || p.title
    || 'Execute one bounded proposal step with measurable outcome'
  ).slice(0, 180);
  const target = normalizeText(src.target || inferTargetFromProposal(p)).slice(0, 180);
  const nextCommand = normalizeText(src.next_command || p.suggested_next_command).slice(0, 320);
  const verify = asStringArray(src.verify || p.validation).slice(0, 6);
  const rollback = normalizeText(
    src.rollback
    || 'Revert scoped proposal changes and restore previous baseline'
  ).slice(0, 180);

  if (!objective || !target || !nextCommand || verify.length === 0 || !rollback) {
    return null;
  }

  const successCriteria = normalizeSuccessCriteria(src.success_criteria, verify);
  if (!Array.isArray(successCriteria) || successCriteria.length === 0) return null;

  return {
    version: Number(src.version || 1),
    objective,
    target,
    next_command: nextCommand,
    verify,
    success_criteria: successCriteria,
    rollback
  };
}

function applyBridge(p) {
  if (!p || typeof p !== 'object') return { changed: false, proposal: p };
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  let changed = false;
  let next = p;
  let nextMeta = { ...meta };

  if (requiresActionSpecContract(p)) {
    const normalizedSpec = normalizeActionSpec(p);
    if (normalizedSpec) {
      const before = p.action_spec && typeof p.action_spec === 'object' ? JSON.stringify(p.action_spec) : '';
      const after = JSON.stringify(normalizedSpec);
      if (before !== after) changed = true;
      next = {
        ...next,
        action_spec: normalizedSpec
      };
      nextMeta = {
        ...nextMeta,
        action_spec_version: Number(normalizedSpec.version || 1),
        action_spec_target: String(normalizedSpec.target || '')
      };
    }
  }

  if (meta.actuation && typeof meta.actuation === 'object' && String(meta.actuation.kind || '').trim()) {
    if (!changed) return { changed: false, proposal: p };
    return {
      changed: true,
      proposal: {
        ...next,
        meta: nextMeta
      }
    };
  }

  let kind = null;
  let params = {};

  // Rule 1: explicit hint object
  if (meta.actuation_hint && typeof meta.actuation_hint === 'object') {
    kind = String(meta.actuation_hint.kind || '').trim() || null;
    params = normalizeParams(meta.actuation_hint.params);
  }

  // Rule 2: actuation_task + title marker
  if (!kind && String(p.type || '') === 'actuation_task') {
    kind = inferKindFromTitle(p.title);
  }

  if (!kind) {
    if (!changed) return { changed: false, proposal: p };
    return {
      changed: true,
      proposal: {
        ...next,
        meta: nextMeta
      }
    };
  }

  const withActuation = {
    ...next,
    meta: {
      ...nextMeta,
      actuation: {
        kind,
        params
      }
    }
  };
  return { changed: true, proposal: withActuation, kind };
}

function run(dateStr, dryRun) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) {
    process.stdout.write(JSON.stringify({ ok: true, result: 'no_proposals_file', date: dateStr, path: fp }) + '\n');
    return;
  }
  const raw = readJson(fp);
  const proposals = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
  if (!Array.isArray(proposals)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid proposals format', path: fp }) + '\n');
    process.exit(1);
  }

  let changed = 0;
  const byKind = {};
  const out = proposals.map((p) => {
    const r = applyBridge(p);
    if (r.changed) {
      changed += 1;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    return r.proposal;
  });

  if (!dryRun && changed > 0) {
    if (Array.isArray(raw)) writeJsonAtomic(fp, out);
    else writeJsonAtomic(fp, { ...raw, proposals: out });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: dryRun ? 'dry_run' : 'bridged',
    date: dateStr,
    changed,
    by_kind: byKind,
    path: fp
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const dateStr = args._[1] && /^\d{4}-\d{2}-\d{2}$/.test(args._[1]) ? args._[1] : todayStr();
  run(dateStr, args['dry-run'] === true);
}

if (require.main === module) main();

module.exports = {
  run,
  applyBridge,
  normalizeActionSpec,
  requiresActionSpecContract
};
export {};

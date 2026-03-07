#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EYES_INTAKE_SCRIPT = path.join(ROOT, 'systems', 'sensory', 'eyes_intake.js');
const PARSER_HINTS_PATH = path.join(ROOT, 'adaptive', 'sensory', 'eyes', 'parser_hints.json');
let parserHintsCache = null;

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeList(v) {
  if (Array.isArray(v)) return v.map((x) => normalizeText(x).toLowerCase()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((x) => normalizeText(x).toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function normalizeHost(v) {
  return normalizeText(v).toLowerCase().replace(/[^a-z0-9.-]+/g, '');
}

function compileParserHints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const parser = normalizeText(row.parser).toLowerCase();
    if (!parser) continue;
    const suffixes = normalizeList(row.suffixes)
      .map((s) => normalizeHost(s))
      .filter(Boolean);
    if (suffixes.length <= 0) continue;
    out.push({ parser, suffixes });
  }
  return out;
}

function loadParserHints() {
  if (parserHintsCache) return parserHintsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(PARSER_HINTS_PATH, 'utf8'));
    parserHintsCache = compileParserHints(raw);
  } catch {
    parserHintsCache = [];
  }
  return parserHintsCache;
}

function normalizeRef(v) {
  return normalizeText(v)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function normalizeRefList(v, maxItems = 12) {
  const src = Array.isArray(v) ? v : normalizeList(v);
  const out = [];
  const seen = new Set();
  for (const row of src) {
    const id = normalizeRef(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= Math.max(1, Number(maxItems) || 12)) break;
  }
  return out;
}

function inferParserType(domain) {
  const d = normalizeHost(domain);
  if (!d) return 'stub';
  const hints = loadParserHints();
  for (const hint of hints) {
    for (const suffix of hint.suffixes) {
      if (d === suffix || d.endsWith(`.${suffix}`)) return hint.parser;
    }
  }
  return 'stub';
}

function normalizeEyeId(v) {
  const clean = normalizeText(v)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!clean) return '';
  return clean.slice(0, 40);
}

function parsePayload(stdout) {
  const text = normalizeText(stdout);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function buildArgs(params, dryRun) {
  const p = params && typeof params === 'object' ? params : {};
  const domains = normalizeList(p.domains || p.proposed_domains);
  const primaryDomain = domains[0] || '';
  const name = normalizeText(p.name || (primaryDomain ? `Watch ${primaryDomain}` : ''));
  const directive = normalizeText(p.directive || p.directive_ref);
  const parser = normalizeText(
    p.parser || p.parser_type || p.proposed_parser_type || inferParserType(primaryDomain)
  ).toLowerCase() || 'stub';
  const eyeId = normalizeEyeId(p.id || p.eye_id || p.proposed_eye_id || p.name);
  const strategyId = normalizeRef(p.strategy_id || p.proposed_strategy_id || p.strategy);
  const campaignIds = normalizeRefList(p.campaign_ids || p.proposed_campaign_ids || p.campaigns);

  if (!name) return { ok: false, error: 'missing_eye_name' };
  if (!directive) return { ok: false, error: 'missing_directive_ref' };
  if (!eyeId) return { ok: false, error: 'missing_eye_id' };
  if (campaignIds.length > 0 && !strategyId) return { ok: false, error: 'campaigns_require_strategy' };

  const args = [
    EYES_INTAKE_SCRIPT,
    'create',
    `--name=${name}`,
    `--id=${eyeId}`,
    `--parser=${parser}`,
    `--directive=${directive}`
  ];
  if (domains.length > 0) args.push(`--domains=${domains.join(',')}`);
  const topics = normalizeList(p.topics || p.proposed_topics);
  if (topics.length > 0) args.push(`--topics=${topics.join(',')}`);
  const notes = normalizeText(p.notes || '');
  if (notes) args.push(`--notes=${notes.slice(0, 180)}`);
  if (strategyId) args.push(`--strategy=${strategyId}`);
  if (campaignIds.length > 0) args.push(`--campaigns=${campaignIds.join(',')}`);
  if (p.status) args.push(`--status=${normalizeText(p.status)}`);
  if (Number.isFinite(Number(p.cadence_hours || p.proposed_cadence_hours))) {
    args.push(`--cadence=${Math.max(1, Number(p.cadence_hours || p.proposed_cadence_hours))}`);
  }
  const budgets = p.budgets && typeof p.budgets === 'object'
    ? p.budgets
    : (p.proposed_budgets && typeof p.proposed_budgets === 'object' ? p.proposed_budgets : {});
  if (Number.isFinite(Number(budgets.max_items))) args.push(`--max-items=${Math.max(1, Number(budgets.max_items))}`);
  if (Number.isFinite(Number(budgets.max_seconds))) args.push(`--max-seconds=${Math.max(1, Number(budgets.max_seconds))}`);
  if (Number.isFinite(Number(budgets.max_bytes))) args.push(`--max-bytes=${Math.max(1024, Number(budgets.max_bytes))}`);
  if (Number.isFinite(Number(budgets.max_requests))) args.push(`--max-requests=${Math.max(0, Number(budgets.max_requests))}`);
  if (p.parser_options && typeof p.parser_options === 'object') {
    args.push(`--parser-options=${JSON.stringify(p.parser_options)}`);
  }
  if (dryRun) args.push('--dry-run');
  return { ok: true, args, parser, eye_id: eyeId, directive, strategy_id: strategyId || null, campaign_ids: campaignIds };
}

async function execute({ params, dryRun }) {
  const spec = buildArgs(params, dryRun === true);
  if (!spec.ok) {
    return {
      ok: false,
      code: 2,
      summary: {
        decision: 'ACTUATE',
        gate_decision: 'DENY',
        executable: false,
        adapter: 'eyes_create',
        verified: false,
        reason: spec.error || 'invalid_params'
      },
      details: { error: spec.error || 'invalid_params' }
    };
  }

  const run = spawnSync(process.execPath, spec.args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const payload = parsePayload(run.stdout || '');
  const ok = run.status === 0 && payload && payload.ok === true;
  if (!ok) {
    return {
      ok: false,
      code: run.status || 1,
      summary: {
        decision: 'ACTUATE',
        gate_decision: 'DENY',
        executable: false,
        adapter: 'eyes_create',
        verified: false,
        reason: normalizeText(run.stderr || (payload && payload.error) || 'eyes_create_failed')
      },
      details: {
        stdout: normalizeText(run.stdout || ''),
        stderr: normalizeText(run.stderr || ''),
        payload
      }
    };
  }

  return {
    ok: true,
    code: 0,
    summary: {
      decision: 'ACTUATE',
      gate_decision: 'ALLOW',
      executable: true,
      adapter: 'eyes_create',
      verified: true,
      action: 'create_eye',
      eye_id: normalizeText(payload.eye_id || spec.eye_id || ''),
      parser_type: spec.parser,
      directive_ref: spec.directive,
      strategy_id: spec.strategy_id || null,
      campaign_ids: spec.campaign_ids || []
    },
    details: payload
  };
}

module.exports = {
  id: 'eyes_create',
  description: 'Create sensory eyes through the eyes_intake controller.',
  execute
};

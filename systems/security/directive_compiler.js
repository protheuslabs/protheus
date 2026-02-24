#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseYaml } = require('../../lib/directive_resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIRECTIVES_DIR = path.join(REPO_ROOT, 'config', 'directives');
const DEFAULT_ACTIVE_PATH = path.join(DEFAULT_DIRECTIVES_DIR, 'ACTIVE.yaml');
const DEFAULT_MAX_DEPTH = 8;

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeLower(v) {
  return normalizeText(v).toLowerCase();
}

function normalizeDirectiveId(v) {
  const id = normalizeText(v);
  if (!/^T[0-9]_[A-Za-z0-9_]+$/.test(id)) return '';
  return id;
}

function tierFromDirectiveId(id) {
  const m = normalizeDirectiveId(id).match(/^T(\d+)_/);
  return m ? Number(m[1]) : 99;
}

function readYamlSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const text = fs.readFileSync(filePath, 'utf8');
    return parseYaml(text) || fallback;
  } catch {
    return fallback;
  }
}

function normalizeActiveRows(parsed) {
  const rows = Array.isArray(parsed && parsed.active_directives)
    ? parsed.active_directives
    : [];
  return rows
    .map((row) => {
      const id = normalizeDirectiveId(
        normalizeText(row && row.id || '').replace(/\.ya?ml$/i, '')
      );
      if (!id) return null;
      const tier = Number.isFinite(Number(row && row.tier))
        ? Number(row.tier)
        : tierFromDirectiveId(id);
      const status = normalizeLower(row && row.status || 'active') || 'active';
      const parentDirectiveId = normalizeDirectiveId(row && row.parent_directive_id || '');
      return {
        id,
        tier,
        status,
        parent_directive_id: parentDirectiveId || ''
      };
    })
    .filter(Boolean);
}

function loadDirectiveParent(directivesDir, id) {
  const fp = path.join(directivesDir, `${id}.yaml`);
  const parsed = readYamlSafe(fp, null);
  if (!parsed || typeof parsed !== 'object') return '';
  const metadata = parsed.metadata && typeof parsed.metadata === 'object'
    ? parsed.metadata
    : {};
  return normalizeDirectiveId(metadata.parent_directive_id || '');
}

function compileDirectiveLineage(opts = {}) {
  const directivesDir = opts.directivesDir
    ? path.resolve(String(opts.directivesDir))
    : DEFAULT_DIRECTIVES_DIR;
  const activePath = opts.activePath
    ? path.resolve(String(opts.activePath))
    : DEFAULT_ACTIVE_PATH;
  const maxDepthDefault = Math.max(1, Number(opts.maxDepth || DEFAULT_MAX_DEPTH));
  const parsed = readYamlSafe(activePath, {});
  const normalizedRows = normalizeActiveRows(parsed);

  const byId = new Map();
  for (const row of normalizedRows) {
    if (!row || row.status !== 'active') continue;
    const parentFromFile = loadDirectiveParent(directivesDir, row.id);
    const parentDirectiveId = row.parent_directive_id || parentFromFile || '';
    byId.set(row.id, {
      id: row.id,
      tier: Number.isFinite(Number(row.tier)) ? Number(row.tier) : tierFromDirectiveId(row.id),
      parent_directive_id: parentDirectiveId || ''
    });
  }

  const digestRows = Array.from(byId.values())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((row) => `${row.id}|${row.tier}|${row.parent_directive_id || ''}`);
  const hash = crypto.createHash('sha256').update(digestRows.join('\n')).digest('hex').slice(0, 16);

  function resolveObjective(objectiveId, resolveOpts = {}) {
    const requireT1Root = resolveOpts.require_t1_root !== false;
    const blockMissingObjective = resolveOpts.block_missing_objective !== false;
    const maxDepth = Math.max(1, Number(resolveOpts.max_depth || maxDepthDefault));
    const id = normalizeDirectiveId(objectiveId);

    if (!id) {
      return {
        pass: blockMissingObjective !== true,
        reason: 'objective_missing',
        objective_id: null,
        root_objective_id: null,
        lineage_path: [],
        depth: 0
      };
    }

    const seen = new Set();
    const chain = [];
    let cur = id;
    let depth = 0;
    let failureReason = '';
    while (cur) {
      if (seen.has(cur)) {
        failureReason = 'lineage_cycle';
        break;
      }
      seen.add(cur);
      chain.push(cur);
      depth += 1;
      if (depth > maxDepth) {
        failureReason = 'lineage_depth_exceeded';
        break;
      }
      const row = byId.get(cur);
      if (!row) {
        failureReason = cur === id ? 'objective_unknown' : 'lineage_parent_missing';
        break;
      }
      cur = normalizeDirectiveId(row.parent_directive_id || '');
    }

    const lineagePath = chain.slice().reverse();
    const rootObjectiveId = lineagePath.length ? lineagePath[0] : null;
    const rootTier = rootObjectiveId ? tierFromDirectiveId(rootObjectiveId) : null;
    if (!failureReason && requireT1Root && rootTier !== 1) {
      failureReason = 'lineage_root_not_t1';
    }

    return {
      pass: !failureReason,
      reason: failureReason || null,
      objective_id: id,
      root_objective_id: rootObjectiveId,
      root_tier: rootTier,
      lineage_path: lineagePath,
      depth: chain.length
    };
  }

  return {
    ok: true,
    type: 'directive_compiler',
    version: '1.0',
    ts: new Date().toISOString(),
    active_path: activePath,
    directives_dir: directivesDir,
    active_count: byId.size,
    hash,
    entries: Array.from(byId.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    resolveObjective
  };
}

function evaluateDirectiveLineageCandidate(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const compiler = opts.compiler && typeof opts.compiler.resolveObjective === 'function'
    ? opts.compiler
    : compileDirectiveLineage(opts);
  const objectiveId = normalizeDirectiveId(src.objective_id || src.objectiveId || '');
  return compiler.resolveObjective(objectiveId, opts);
}

function extractObjectiveIdFromProposal(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const id = normalizeDirectiveId(
    actionSpec.objective_id
    || meta.objective_id
    || meta.directive_objective_id
    || p.objective_id
    || ''
  );
  return id || '';
}

module.exports = {
  compileDirectiveLineage,
  evaluateDirectiveLineageCandidate,
  extractObjectiveIdFromProposal,
  normalizeDirectiveId,
  tierFromDirectiveId
};

